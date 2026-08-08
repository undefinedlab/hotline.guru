import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseIntent } from "./intent.js";

describe("parseIntent", () => {
  it("parses the spoken demo sentence", () => {
    const a = parseIntent("send 10 usdt to +15551230002");
    assert.deepEqual(a, { action: "send", amount: 10, to: "+15551230002" });

    const b = parseIntent("Send 10 USDT to this number +1-555-123-0002");
    assert.equal(b.action, "send");
    if (b.action === "send") {
      assert.equal(b.amount, 10);
      assert.equal(b.to, "+15551230002");
    }

    const c = parseIntent("pay 5 dollars to 5551234567");
    assert.equal(c.action, "send");
    if (c.action === "send") {
      assert.equal(c.amount, 5);
      assert.equal(c.to, "+15551234567");
    }
  });

  it("parses Arc swap pairs", () => {
    assert.deepEqual(parseIntent("swap 10 usdc to eurc"), {
      action: "swap",
      amount: 10,
      tokenIn: "USDC",
      tokenOut: "EURC",
    });
    assert.deepEqual(parseIntent("swap 1 dollar to euro"), {
      action: "swap",
      amount: 1,
      tokenIn: "USDC",
      tokenOut: "EURC",
    });
    assert.deepEqual(parseIntent("swap a dollar to euro"), {
      action: "swap",
      amount: 1,
      tokenIn: "USDC",
      tokenOut: "EURC",
    });
    assert.deepEqual(parseIntent("swap 1 to euro"), {
      action: "swap",
      amount: 1,
      tokenIn: "USDC",
      tokenOut: "EURC",
    });
    assert.deepEqual(parseIntent("exchange 5 euro for usdc"), {
      action: "swap",
      amount: 5,
      tokenIn: "EURC",
      tokenOut: "USDC",
    });
    assert.deepEqual(parseIntent("convert 1 usdc into bitcoin"), {
      action: "swap",
      amount: 1,
      tokenIn: "USDC",
      tokenOut: "cirBTC",
    });
    assert.deepEqual(parseIntent("swap 0.01 cirbtc to euro"), {
      action: "swap",
      amount: 0.01,
      tokenIn: "cirBTC",
      tokenOut: "EURC",
    });
    // fraud report must not become a token swap
    assert.equal(parseIntent("sim swap").action, "report_sim");
  });

  it("normalizes spoken usdc into dollar swap", async () => {
    const { normalizeTranscript } = await import("./stt.js");
    const n = normalizeTranscript("swap one USDC to euro");
    assert.match(n, /swap 1 dollar to euro/);
    assert.deepEqual(parseIntent(n), {
      action: "swap",
      amount: 1,
      tokenIn: "USDC",
      tokenOut: "EURC",
    });
  });

  it("parses join / pin / confirm", () => {
    assert.deepEqual(parseIntent("JOIN alice"), { action: "join", name: "alice" });
    assert.deepEqual(parseIntent("PIN 1234"), { action: "set_pin", pin: "1234" });
    assert.deepEqual(parseIntent("CONFIRM 1234"), { action: "confirm", pin: "1234" });
  });

  it("parses hello and my name is", () => {
    assert.equal(parseIntent("hi").action, "hello");
    assert.deepEqual(parseIntent("my name is Ben"), { action: "set_name", name: "Ben" });
    assert.deepEqual(parseIntent("I'm Alex"), { action: "set_name", name: "Alex" });
  });
});
