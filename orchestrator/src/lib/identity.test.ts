import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DATABASE_PATH = "./data/identity-test.db";
process.env.WALLET_MODE = "local";
process.env.SIM_ATTEST_MODE = "mock";
delete process.env.DATABASE_URL;
try {
  fs.unlinkSync("./data/identity-test.db");
} catch {
  /* ok */
}

const { initDb, upsertUser } = await import("./db.js");
await initDb();
const { claimName, displayHotline, isValidHotlineName, lookupName } = await import("./hotlinens.js");
const { attestSim, identitySummary, limitsForTier, verifyNationalId } = await import(
  "./identity.js"
);
const { evaluatePolicy, policyLimits } = await import("./policy.js");
const { parseIntent } = await import("./intent.js");
const { resolvePayee } = await import("./contacts.js");

describe("HotlineNS", () => {
  it("validates labels", () => {
    assert.equal(isValidHotlineName("alice"), true);
    assert.equal(isValidHotlineName("admin"), false);
    assert.equal(displayHotline("Alice"), "alice.hotline");
  });

  it("claims and resolves", async () => {
    await upsertUser({
      phone: "+15551110001",
      wallet_address: "0x1111111111111111111111111111111111111111",
      wallet_ref: "local:1",
      name: "Alice",
    });
    const { label } = await claimName("+15551110001", "alice");
    assert.equal(label, "alice.hotline");
    const hit = await lookupName("alice.hotline");
    assert.equal(hit?.phone, "+15551110001");
    const payee = await resolvePayee("+15551110099", "alice.hotline");
    assert.equal(payee?.phone, "+15551110001");
  });
});

describe("identity tiers", () => {
  it("parses verify / attest / claim intents", () => {
    assert.deepEqual(parseIntent("CLAIM bob"), { action: "claim_name", name: "bob" });
    assert.deepEqual(parseIntent("VERIFY ID AB12-34"), {
      action: "verify_id",
      nationalId: "AB12-34",
    });
    assert.equal(parseIntent("ATTEST SIM").action, "attest_sim");
    assert.equal(parseIntent("IDENTITY").action, "identity");
  });

  it("raises caps after ID + SIM attest", async () => {
    await upsertUser({
      phone: "+15552220002",
      wallet_address: "0x2222222222222222222222222222222222222222",
      wallet_ref: "local:2",
      name: "Bob",
    });

    const t0 = policyLimits(0);
    let v = await evaluatePolicy("+15552220002", {
      action: "send",
      amount: t0.hardCeiling + 1,
      to: "x",
    });
    assert.equal(v.status, "reject");

    await verifyNationalId("+15552220002", "NID-9999");
    const t1 = limitsForTier(1);
    assert.ok(t1.perTx > t0.perTx);

    const att = await attestSim("+15552220002");
    assert.equal(att.user.identity_tier, 2);
    assert.match(identitySummary(att.user), /Tier 2/);

    const t2 = policyLimits(2);
    v = await evaluatePolicy("+15552220002", {
      action: "send",
      amount: t2.perTx,
      to: "x",
    });
    assert.equal(v.status, "confirm");
  });
});
