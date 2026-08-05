import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { ingressRateLimit, rateLimit, resetRateLimits } from "./rateLimit.js";
import { assertProfileConfig, channelStatus, hotlineProfile } from "./profile.js";
import {
  verifyAtWebhook,
  verifyGenericHmac,
  verifyTelnyxSignature,
} from "./webhooks.js";

describe("rateLimit", () => {
  it("allows then blocks", () => {
    resetRateLimits();
    const a = rateLimit({ key: "t1", limit: 2, windowMs: 60_000 });
    const b = rateLimit({ key: "t1", limit: 2, windowMs: 60_000 });
    const c = rateLimit({ key: "t1", limit: 2, windowMs: 60_000 });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(c.ok, false);
    assert.ok(c.retryAfterSec >= 1);
  });

  it("ingress helper works", () => {
    resetRateLimits();
    process.env.RATE_LIMIT_PER_MIN = "5";
    assert.equal(ingressRateLimit("+15550001").ok, true);
  });
});

describe("webhooks", () => {
  it("rejects Telnyx when WEBHOOK_VERIFY=1 and no key", () => {
    process.env.WEBHOOK_VERIFY = "1";
    delete process.env.TELNYX_PUBLIC_KEY;
    delete process.env.TELNYX_WEBHOOK_SECRET;
    const v = verifyTelnyxSignature("{}", { signature: "x", timestamp: "1" });
    assert.equal(v.ok, false);
    delete process.env.WEBHOOK_VERIFY;
  });

  it("verifies Telnyx HMAC lab secret", () => {
    process.env.WEBHOOK_VERIFY = "1";
    delete process.env.TELNYX_PUBLIC_KEY;
    process.env.TELNYX_WEBHOOK_SECRET = "lab-secret";
    const body = '{"ok":true}';
    const ts = "1710000000";
    const sig = createHmac("sha256", "lab-secret").update(`${ts}.${body}`).digest("hex");
    assert.equal(verifyTelnyxSignature(body, { signature: sig, timestamp: ts }).ok, true);
    assert.equal(verifyTelnyxSignature(body, { signature: "dead", timestamp: ts }).ok, false);
    delete process.env.WEBHOOK_VERIFY;
    delete process.env.TELNYX_WEBHOOK_SECRET;
  });

  it("verifies Telnyx ed25519 when public key set", () => {
    process.env.WEBHOOK_VERIFY = "1";
    delete process.env.TELNYX_WEBHOOK_SECRET;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ type: "spki", format: "der" });
    // raw 32-byte key is last 32 bytes of SPKI
    const raw = spki.subarray(spki.length - 32);
    process.env.TELNYX_PUBLIC_KEY = raw.toString("base64");
    const body = '{"hello":"telnyx"}';
    const ts = "1710000001";
    const signature = sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64");
    assert.equal(verifyTelnyxSignature(body, { signature, timestamp: ts }).ok, true);
    delete process.env.WEBHOOK_VERIFY;
    delete process.env.TELNYX_PUBLIC_KEY;
  });

  it("verifies AT shared secret", () => {
    process.env.WEBHOOK_VERIFY = "1";
    process.env.AT_WEBHOOK_SECRET = "at-secret";
    assert.equal(verifyAtWebhook({ headerSecret: "at-secret" }).ok, true);
    assert.equal(verifyAtWebhook({ headerSecret: "nope" }).ok, false);
    delete process.env.WEBHOOK_VERIFY;
    delete process.env.AT_WEBHOOK_SECRET;
  });

  it("verifies generic SMS HMAC", () => {
    process.env.WEBHOOK_VERIFY = "1";
    process.env.SMS_WEBHOOK_SECRET = "sms-secret";
    const body = "From=%2B1&Body=hi";
    const sig = createHmac("sha256", "sms-secret").update(body).digest("hex");
    assert.equal(verifyGenericHmac(body, sig).ok, true);
    delete process.env.WEBHOOK_VERIFY;
    delete process.env.SMS_WEBHOOK_SECRET;
  });
});

describe("profile", () => {
  it("lab is default", () => {
    delete process.env.HOTLINE_PROFILE;
    assert.equal(hotlineProfile(), "lab");
  });

  it("staging refuses weak secrets", () => {
    process.env.HOTLINE_PROFILE = "staging";
    process.env.WALLET_SECRET = "dev-only-change-me";
    process.env.WEBHOOK_VERIFY = "0";
    delete process.env.AUDIT_EXPORT_TOKEN;
    delete process.env.DATABASE_URL;
    assert.throws(() => assertProfileConfig(), /refused weak config/);
    delete process.env.HOTLINE_PROFILE;
  });

  it("channelStatus does not leak secrets", () => {
    const s = channelStatus();
    assert.ok(s.sms);
    assert.equal("apiKey" in s.sms, false);
  });
});
