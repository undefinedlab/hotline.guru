import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseIntent } from "./intent.js";
import { evaluatePolicy, policyLimits } from "./policy.js";

describe("parseIntent", () => {
  it("parses join", () => {
    assert.deepEqual(parseIntent("JOIN alice"), { action: "join", name: "alice" });
  });
  it("parses send", () => {
    assert.deepEqual(parseIntent("SEND 2 USDC TO bob"), {
      action: "send",
      amount: 2,
      to: "bob",
    });
  });
  it("parses price", () => {
    assert.equal(parseIntent("what's the price of bitcoin").action, "price");
  });
  it("parses confirm with pin", () => {
    assert.deepEqual(parseIntent("CONFIRM 1234"), { action: "confirm", pin: "1234" });
  });
});

describe("policy", () => {
  it("hard-rejects over ceiling", () => {
    const limits = policyLimits();
    const v = evaluatePolicy("+15550009999", {
      action: "send",
      amount: limits.hardCeiling + 1,
      to: "bob",
    });
    assert.equal(v.status, "reject");
  });
  it("asks confirm under soft path", () => {
    const v = evaluatePolicy("+15550009999", { action: "send", amount: 1, to: "bob" });
    assert.equal(v.status, "confirm");
  });
  it("passes price nanopay under budget", () => {
    const v = evaluatePolicy("+15550008888", { action: "price", symbol: "bitcoin" });
    assert.equal(v.status, "pass");
  });
});
