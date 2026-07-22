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

describe("pipeline", () => {
  it("onboards name then greets on recall", async () => {
    const first = await handleCallStart("+15559990001");
    assert.match(first.reply, /name/i);
    assert.equal(first.needsName, true);

    const named = await handleMessage("+15559990001", "Ben");
    assert.match(named.reply, /Nice to meet you, Ben/i);

    const recall = await handleCallStart("+15559990001");
    assert.match(recall.reply, /Hey Ben, what can I do for you/i);
  });

  it("blocks send until named, then policy refuse", async () => {
    const ask = await handleMessage("+15559990011", "send 1 usdt to +15559990012");
    assert.match(ask.reply, /name/i);
    await handleMessage("+15559990011", "Alex");

    const bad = await handleMessage("+15559990011", "send 100 usdt to +15559990012");
    assert.match(bad.reply, /Hard ceiling|No —/i);
  });
});
