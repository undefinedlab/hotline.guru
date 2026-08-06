import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compilePolicyRules, describeRules } from "./policyRules.js";
import { parseIntent } from "./intent.js";
import { parseUnlockDate } from "./retention.js";

describe("spoken policy compile", () => {
  it("compiles the demo sentence", () => {
    const rules = compilePolicyRules(
      "never send more than ten dollars to someone I haven't paid before",
    );
    assert.ok(rules);
    assert.equal(rules![0]!.kind, "max_new_payee_usdc");
    assert.equal(rules![0]!.maxUsdc, 10);
    assert.match(describeRules(rules!), /10/);
  });

  it("parses POLICY prefix", () => {
    const i = parseIntent(
      "POLICY never send more than ten dollars to someone I haven't paid before",
    );
    assert.equal(i.action, "set_policy");
  });

  it("parses standing order", () => {
    const i = parseIntent("send 50 usdt to +15551234567 every month");
    assert.equal(i.action, "standing");
    if (i.action === "standing") {
      assert.equal(i.amount, 50);
      assert.equal(i.cadence, "monthly");
    }
  });

  it("parses savings lock", () => {
    const i = parseIntent("lock 5 until december");
    assert.equal(i.action, "lock_savings");
    if (i.action === "lock_savings") {
      assert.equal(i.amount, 5);
      assert.ok(parseUnlockDate(i.until));
    }
  });

  it("parses dial-a-rate", () => {
    assert.equal(parseIntent("rate").action, "rate");
  });

  it("parses shop and buy", () => {
    assert.deepEqual(parseIntent("shop tee"), { action: "shop", query: "tee" });
    assert.deepEqual(parseIntent("BUY unisex-tee"), {
      action: "buy",
      handleOrIndex: "unisex-tee",
    });
  });
});
