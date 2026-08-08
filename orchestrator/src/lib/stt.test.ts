import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTranscript } from "./stt.js";
import { parseIntent } from "./intent.js";

describe("normalizeTranscript", () => {
  it("repairs hus + digit phone into a send intent", () => {
    const n = normalizeTranscript("Send 10-HUS to plus 1-5-5-5-1-2-3-0-0-0-2");
    assert.match(n, /dollar|usdt/);
    assert.match(n, /\+15551230002/);
    const intent = parseIntent(n);
    assert.equal(intent.action, "send");
    if (intent.action === "send") {
      assert.equal(intent.amount, 10);
      assert.equal(intent.to, "+15551230002");
    }
  });

  it("scoops split digits after to", () => {
    const n = normalizeTranscript("send 10 usdt to plus 1 5 5 1 to 3 0 0 0 2");
    assert.match(n, /\+155130002/);
  });

  it("keeps euro after to for swaps", () => {
    const n = normalizeTranscript("swap 1 dollar to euro");
    assert.equal(n, "swap 1 dollar to euro");
    assert.equal(parseIntent(n).action, "swap");
  });

  it("repairs real Whisper mishears from the Irish DID", () => {
    const a = normalizeTranscript("slap $1 to era");
    assert.match(a, /swap 1 dollar to euro/);
    assert.equal(parseIntent(a).action, "swap");

    const b = normalizeTranscript("so, what, 1 dollar to you?");
    assert.match(b, /swap 1 dollar to euro/);
    assert.equal(parseIntent(b).action, "swap");

    const c = normalizeTranscript("exchange one dollar for euro");
    assert.deepEqual(parseIntent(c), {
      action: "swap",
      amount: 1,
      tokenIn: "USDC",
      tokenOut: "EURC",
    });

    const d = normalizeTranscript("clumps for 1 dollar to james");
    assert.match(d, /^send 1 dollar to james/);
    assert.equal(parseIntent(d).action, "send");

    const e = normalizeTranscript("stand 1 dollar to plus 353899494966");
    assert.match(e, /send 1 dollar to \+353/);
    assert.equal(parseIntent(e).action, "send");
  });

  it("repairs spoken hotline names", () => {
    const n = normalizeTranscript("send one dollar to james hotline");
    assert.match(n, /send 1 dollar to james\.hotline/);
    assert.equal(parseIntent(n).action, "send");
  });
});
