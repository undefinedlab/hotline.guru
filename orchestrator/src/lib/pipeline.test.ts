import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DATABASE_PATH = "./data/pipeline-test.db";
process.env.WALLET_MODE = "local";
process.env.DEMO_SIMPLE = "1";
try {
  fs.unlinkSync("./data/pipeline-test.db");
} catch {
  /* ok */
}

const { handleMessage, handleCallStart } = await import("./pipeline.js");
const { getUser } = await import("./db.js");

describe("pipeline", () => {
  it("onboards name then greets on recall", async () => {
    const first = await handleCallStart("+15559990001");
    assert.match(first.reply, /Welcome|name/i);
    assert.equal(first.needsName, true);

    const named = await handleMessage("+15559990001", "Ben");
    assert.match(named.reply, /Nice to meet you, Ben/i);

    const recall = await handleCallStart("+15559990001");
    assert.match(recall.reply, /Hey Ben, what can I do for you/i);
  });

  it("blocks send until named, then policy refuse", async () => {
    const ask = await handleMessage("+15559990011", "send 1 usdt to +15559990012");
    assert.match(ask.reply, /name|Welcome/i);
    await handleMessage("+15559990011", "Alex");

    const bad = await handleMessage("+15559990011", "send 100 usdt to +15559990012");
    assert.match(bad.reply, /Hard ceiling|No —/i);
  });
});

describe("pipeline full onboard + phone payee", () => {
  it("welcome → name → PIN → thanks; next call greets", async () => {
    process.env.DEMO_SIMPLE = "0";
    const phone = "+15559990201";

    const welcome = await handleCallStart(phone);
    assert.equal(welcome.needsName, true);
    assert.equal(welcome.onboarding, true);
    assert.ok(welcome.data?.address);

    const named = await handleMessage(phone, "Casey");
    assert.equal(named.needsSetPin, true);
    assert.match(named.reply, /PIN/i);

    const beforePin = getUser(phone)!;
    assert.equal(beforePin.name, "Casey");
    assert.ok(beforePin.wallet_address);
    assert.equal(beforePin.pin_hash, null);

    const pinned = await handleMessage(phone, "PIN 4242");
    assert.match(pinned.reply, /all set|Thanks/i);
    assert.equal(pinned.data?.onboarded, true);

    const recall = await handleCallStart(phone);
    assert.equal(recall.needsName, undefined);
    assert.equal(recall.needsSetPin, undefined);
    assert.match(recall.reply, /Hey Casey/i);
  });

  it("send to unknown number provisions their wallet; they keep it on onboard", async () => {
    process.env.DEMO_SIMPLE = "0";
    const sender = "+15559990211";
    const receiver = "+15559990212";

    await handleCallStart(sender);
    await handleMessage(sender, "Dana");
    await handleMessage(sender, "PIN 5555");

    assert.equal(getUser(receiver), undefined);

    const pending = await handleMessage(sender, `send 1 usdt to ${receiver}`);
    assert.equal(pending.needsPin, true);
    assert.equal(pending.data?.provisioned, true);
    assert.equal(pending.data?.toPhone, receiver);

    const recv = getUser(receiver);
    assert.ok(recv, "receiver wallet created at send time");
    assert.equal(recv.name, null);
    assert.equal(recv.pin_hash, null);
    const recvAddr = recv.wallet_address;

    // Receiver later onboards — same wallet, no new address
    const welcome = await handleCallStart(receiver);
    assert.equal(welcome.needsName, true);
    assert.equal(welcome.data?.address, recvAddr);
    await handleMessage(receiver, "Eve");
    await handleMessage(receiver, "PIN 9999");
    assert.equal(getUser(receiver)!.wallet_address, recvAddr);
    assert.equal(getUser(receiver)!.name, "Eve");
  });

  it("hard ceiling still refuses without PIN dance", async () => {
    process.env.DEMO_SIMPLE = "0";
    const phone = "+15559990221";
    await handleCallStart(phone);
    await handleMessage(phone, "Frank");
    await handleMessage(phone, "PIN 5555");

    const bad = await handleMessage(phone, "send 100 usdt to +15559990222");
    assert.equal(bad.needsPin, undefined);
    assert.match(bad.reply, /Hard ceiling|No —/i);
  });
});
