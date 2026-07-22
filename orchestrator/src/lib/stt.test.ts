import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTranscript } from "./stt.js";
import { parseIntent } from "./intent.js";

describe("normalizeTranscript", () => {
  it("repairs hus + digit phone into a send intent", () => {
    const n = normalizeTranscript("Send 10-HUS to plus 1-5-5-5-1-2-3-0-0-0-2");
    assert.match(n, /usdt/);
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
});
