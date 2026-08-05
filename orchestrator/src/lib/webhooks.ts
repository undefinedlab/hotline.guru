import { createHmac, timingSafeEqual } from "node:crypto";
import { log } from "./log.js";

/**
 * Webhook signature stubs.
 * - Lab (WEBHOOK_VERIFY=0 / unset): accept, log if secret missing
 * - Staging/prod (WEBHOOK_VERIFY=1): require valid HMAC
 */
export function webhookVerifyEnabled(): boolean {
  return process.env.WEBHOOK_VERIFY === "1";
}

export function verifyTelnyxSignature(
  rawBody: string,
  headers: { signature?: string | null; timestamp?: string | null },
): { ok: boolean; reason?: string } {
  const secret = process.env.TELNYX_PUBLIC_KEY ?? process.env.TELNYX_WEBHOOK_SECRET;
  if (!secret) {
    if (webhookVerifyEnabled()) return { ok: false, reason: "TELNYX webhook secret not configured" };
    log.warn("telnyx webhook accepted without verification (set WEBHOOK_VERIFY=1 + secret)");
    return { ok: true };
  }
  const sig = headers.signature ?? "";
  const ts = headers.timestamp ?? "";
  if (!sig || !ts) {
    if (webhookVerifyEnabled()) return { ok: false, reason: "missing signature headers" };
    return { ok: true };
  }
  // Stub: HMAC-SHA256(timestamp + rawBody) hex — replace with Telnyx ed25519 when keys ready
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "bad signature" };
    }
  } catch {
    return { ok: false, reason: "signature compare failed" };
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
