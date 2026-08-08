/**
 * Twilio Programmable Voice — a real phone number without a public SIP host.
 *
 * Twilio POSTs to /webhooks/twilio/voice, we answer with TwiML. Twilio does the
 * speech-to-text and text-to-speech, so this path needs neither Asterisk nor the
 * Whisper container — it tunnels through ngrok, unlike UDP SIP.
 *
 * Setup: Twilio Console → your number → Voice → "A call comes in" → Webhook
 *        POST https://<public-host>/webhooks/twilio/voice
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { webhookVerifyEnabled } from "./webhooks.js";
import { log } from "./log.js";

/**
 * Twilio signs the full URL plus the POST params, sorted by key and concatenated.
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signatureHeader: string | null | undefined,
): { ok: boolean; reason?: string } {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) {
    if (webhookVerifyEnabled()) return { ok: false, reason: "TWILIO_AUTH_TOKEN not set" };
    log.warn("twilio webhook accepted without verification");
    return { ok: true };
  }
  if (!signatureHeader) {
    if (webhookVerifyEnabled()) return { ok: false, reason: "missing X-Twilio-Signature" };
    return { ok: true };
  }
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  const expected = createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
  try {
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
  } catch {
    return { ok: false, reason: "signature compare failed" };
  }
  return { ok: true };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Strip URLs — a voice engine reading an ArcScan link aloud is unlistenable. */
export function speakable(reply: string): string {
  const out = reply.replace(/https?:\/\/\S+/g, "").replace(/\s{2,}/g, " ").trim();
  return out || "Done.";
}

/**
 * Twilio holds no state between requests, so what the digits *mean* rides in the
 * Gather action URL. The pipeline wants `PIN 1234` to set one and `CONFIRM 1234`
 * to approve a send — bare digits parse as neither.
 */
export type PinExpectation = "setpin" | "pin";

export type TwimlTurn = {
  /** What to say before listening again. */
  reply: string;
  /** PIN digits — never ask a caller to speak these. */
  expect?: PinExpectation;
  /** End the call instead of gathering again. */
  hangup?: boolean;
};

export function twiml(turn: TwimlTurn, action = "/webhooks/twilio/gather"): string {
  const say = `<Say voice="alice">${esc(speakable(turn.reply))}</Say>`;
  if (turn.hangup) return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Hangup/></Response>`;

  const next = turn.expect ? `${action}?expect=${turn.expect}` : action;
  const gather = turn.expect
    ? `<Gather input="dtmf" numDigits="4" timeout="12" action="${esc(next)}" method="POST"/>`
    : `<Gather input="speech dtmf" speechTimeout="auto" timeout="8" action="${action}" method="POST"/>`;

  // If the caller says nothing, Gather falls through — redirect so the call does not die silently.
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>${say}${gather}` +
    `<Redirect method="POST">${action}?idle=1</Redirect></Response>`
  );
}

/** Turn keypad digits into the command the pipeline actually parses. */
export function textForPipeline(raw: string, expect: string | undefined): string {
  if (!/^\d{4,}$/.test(raw)) return raw;
  if (expect === "setpin") return `PIN ${raw}`;
  if (expect === "pin") return `CONFIRM ${raw}`;
  return raw;
}

/** Twilio sends speech in SpeechResult and keypad in Digits. */
export function callerText(params: Record<string, string>): string {
  return (params.SpeechResult || params.Digits || "").trim();
}
