import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { log } from "./log.js";

/**
 * Webhook signature verification.
 * - Lab (WEBHOOK_VERIFY unset/0): accept; warn if secret missing
 * - Staging/prod (WEBHOOK_VERIFY=1): require valid signature
 */
export function webhookVerifyEnabled(): boolean {
  return process.env.WEBHOOK_VERIFY === "1";
}

/**
 * Telnyx: prefer ed25519 (TELNYX_PUBLIC_KEY = portal public key, base64 or PEM).
 * Fallback: HMAC-SHA256 with TELNYX_WEBHOOK_SECRET over `${ts}.${rawBody}` (lab).
 * Signed payload for ed25519: `${timestamp}|${rawBody}` (Telnyx docs).
 */
export function verifyTelnyxSignature(
  rawBody: string,
  headers: { signature?: string | null; timestamp?: string | null },
): { ok: boolean; reason?: string } {
  const ed25519Key = process.env.TELNYX_PUBLIC_KEY;
  const hmacSecret = process.env.TELNYX_WEBHOOK_SECRET;
  if (!ed25519Key && !hmacSecret) {
    if (webhookVerifyEnabled()) return { ok: false, reason: "TELNYX webhook key not configured" };
    log.warn("telnyx webhook accepted without verification (set WEBHOOK_VERIFY=1 + TELNYX_PUBLIC_KEY)");
    return { ok: true };
  }
  const sig = headers.signature ?? "";
  const ts = headers.timestamp ?? "";
  if (!sig || !ts) {
    if (webhookVerifyEnabled()) return { ok: false, reason: "missing Telnyx signature headers" };
    return { ok: true };
  }

  if (ed25519Key) {
    try {
      const keyObj = ed25519Key.includes("BEGIN")
        ? createPublicKey(ed25519Key)
        : createPublicKey({
            key: Buffer.concat([
              // Ed25519 SubjectPublicKeyInfo prefix + 32-byte raw key
              Buffer.from("302a300506032b6570032100", "hex"),
              Buffer.from(ed25519Key, "base64"),
            ]),
            format: "der",
            type: "spki",
          });
      const payload = Buffer.from(`${ts}|${rawBody}`);
      const signature = Buffer.from(sig, "base64");
      const ok = cryptoVerify(null, payload, keyObj, signature);
      return ok ? { ok: true } : { ok: false, reason: "bad Telnyx ed25519 signature" };
    } catch (e) {
      return { ok: false, reason: `Telnyx ed25519 verify failed: ${String(e)}` };
    }
  }

  const expected = createHmac("sha256", hmacSecret!).update(`${ts}.${rawBody}`).digest("hex");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "bad Telnyx HMAC signature" };
    }
  } catch {
    return { ok: false, reason: "signature compare failed" };
  }
  return { ok: true };
}

/** Africa's Talking — shared secret via header or query (AT does not sign bodies). */
export function verifyAtWebhook(opts: {
  headerSecret?: string | null;
  querySecret?: string | null;
}): { ok: boolean; reason?: string } {
  const expected = process.env.AT_WEBHOOK_SECRET;
  if (!expected) {
    if (webhookVerifyEnabled()) return { ok: false, reason: "AT_WEBHOOK_SECRET not set" };
    log.warn("AT webhook accepted without verification");
    return { ok: true };
  }
  const got = opts.headerSecret ?? opts.querySecret ?? "";
  if (!got) {
    if (webhookVerifyEnabled()) return { ok: false, reason: "missing AT webhook secret" };
    return { ok: true };
  }
  try {
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "bad AT webhook secret" };
    }
  } catch {
    return { ok: false, reason: "AT secret compare failed" };
  }
  return { ok: true };
}

export function verifyGenericHmac(
  rawBody: string,
  signatureHeader: string | null | undefined,
): { ok: boolean; reason?: string } {
  const secret = process.env.SMS_WEBHOOK_SECRET;
  if (!secret) {
    if (webhookVerifyEnabled()) return { ok: false, reason: "SMS_WEBHOOK_SECRET not set" };
    log.warn("sms webhook accepted without verification");
    return { ok: true };
  }
  if (!signatureHeader) {
    if (webhookVerifyEnabled()) return { ok: false, reason: "missing X-Hotline-Signature" };
    return { ok: true };
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(signatureHeader.replace(/^sha256=/i, ""));
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
  } catch {
    return { ok: false, reason: "signature compare failed" };
  }
  return { ok: true };
}
