import { test } from "node:test";
import assert from "node:assert/strict";
import { workerIntervalMs } from "./workers.js";

test("worker interval resolves minutes and disables safely", () => {
  assert.equal(workerIntervalMs("15"), 15 * 60_000);
  assert.equal(workerIntervalMs(undefined), 15 * 60_000, "defaults to 15 min");

  // 0 disables — the switch for running more than one orchestrator.
  assert.equal(workerIntervalMs("0"), 0);

  // Garbage must disable, never fall through to a hot loop.
  for (const bad of ["", "abc", "-5", "NaN"]) {
    assert.equal(workerIntervalMs(bad), 0, `"${bad}" should disable`);
  }
});
