import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DATABASE_PATH = "./data/pipeline-test.db";
process.env.WALLET_MODE = "local";
process.env.DEMO_SIMPLE = "1";
delete process.env.DATABASE_URL;
try {
  fs.unlinkSync("./data/pipeline-test.db");
} catch {
  /* ok */
}

const { initDb, getUser } = await import("./db.js");
await initDb();
const { handleMessage, handleCallStart } = await import("./pipeline.js");

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

    const beforePin = (await getUser(phone))!;
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

  it("send to unknown number opens pending claim — no wallet until they onboard", async () => {
    process.env.DEMO_SIMPLE = "0";
    const sender = "+15559990211";
    const receiver = "+15559990212";

    await handleCallStart(sender);
    await handleMessage(sender, "Dana");
    await handleMessage(sender, "PIN 5555");

    assert.equal(await getUser(receiver), undefined);

    const pending = await handleMessage(sender, `send 1 usdt to ${receiver}`);
    assert.equal(pending.needsPin, true);
    assert.equal(pending.data?.pendingClaim, true);
    assert.equal(pending.data?.toPhone, receiver);
    assert.equal(await getUser(receiver), undefined, "no unconsented wallet mint");

    const welcome = await handleCallStart(receiver);
    assert.equal(welcome.needsName, true);
    await handleMessage(receiver, "Eve");
    await handleMessage(receiver, "PIN 9999");
    assert.equal((await getUser(receiver))!.name, "Eve");
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

  it("locks PIN after repeated failures", async () => {
    process.env.DEMO_SIMPLE = "0";
    process.env.PIN_MAX_FAILS = "3";
    process.env.PIN_LOCK_MINUTES = "15";
    const phone = "+15559990231";
    const payee = "+15559990232";
    await handleCallStart(phone);
    await handleMessage(phone, "Gina");
    await handleMessage(phone, "PIN 1234");

    await handleMessage(phone, `send 1 usdt to ${payee}`);
    await handleMessage(phone, "CONFIRM 0000");
    await handleMessage(phone, "CONFIRM 0000");
    const locked = await handleMessage(phone, "CONFIRM 0000");
    assert.match(locked.reply, /locked|cancelled/i);
  });

  it("spoken policy compiles, freezes on PIN, then rejects over new-payee cap", async () => {
    process.env.DEMO_SIMPLE = "0";
    const phone = "+15559990301";
    await handleCallStart(phone);
    await handleMessage(phone, "Helen");
    await handleMessage(phone, "PIN 4321");

    const draft = await handleMessage(
      phone,
      "never send more than ten dollars to someone I haven't paid before",
    );
    assert.equal(draft.needsPin, true);
    assert.match(draft.reply, /ten|10|freeze/i);

    const frozen = await handleMessage(phone, "CONFIRM 4321");
    assert.match(frozen.reply, /Frozen/i);

    const refused = await handleMessage(phone, "send 15 usdt to +15559990399");
    assert.match(refused.reply, /Your rule|No —/i);
  });
});
