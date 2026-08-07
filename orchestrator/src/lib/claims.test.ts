import { test } from "node:test";
import assert from "node:assert/strict";
import { payableAmount, escrowGasReserve } from "./claims.js";

// Arc pays gas in USDC: escrow receives exactly the claim, so forwarding it all reverts.
test("escrow payout reserves gas instead of reverting", () => {
  // The real failure: claim 0.1, escrow holds exactly 0.1 → must send less, not 0.1.
  const pay = payableAmount(0.1, 0.1, 0.005);
  assert.ok(pay > 0 && pay < 0.1, `expected 0 < pay < 0.1, got ${pay}`);
  assert.equal(pay, 0.095);

  // Funded escrow (other claims pooled) pays the full claim.
  assert.equal(payableAmount(0.1, 5, 0.005), 0.1);

  // Dust below the reserve pays nothing — caller leaves the claim held.
  assert.ok(payableAmount(0.1, 0.004, 0.005) <= 0);

  // Never round up past the balance (USDC is 6dp).
  assert.ok(payableAmount(1, 0.1234567, 0) <= 0.1234567);

  assert.ok(escrowGasReserve() > 0);
});
