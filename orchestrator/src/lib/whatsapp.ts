/**
 * WhatsApp Cloud API ingress (Meta).
 * Lab: WHATSAPP_PROVIDER=mock logs outbound.
 * Live: WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID (+ verify token for webhook).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { accountFromWhatsApp } from "./channel.js";
import { log } from "./log.js";
import { webhookVerifyEnabled } from "./webhooks.js";

export type WhatsAppInbound = {
  account: string;
  text: string;
  messageId?: string;
  fromWaId: string;
};

export interface WhatsAppProvider {
  name: string;
  send(toWaId: string, body: string): Promise<void>;
}

export class MockWhatsAppProvider implements WhatsAppProvider {
  name = "mock";
  sent: { to: string; body: string }[] = [];
  async send(to: string, body: string) {
    this.sent.push({ to, body });
    console.log(`[whatsapp:mock] → ${to}: ${body}`);
  }
}

export class MetaWhatsAppProvider implements WhatsAppProvider {
  name = "meta";
  constructor(
    private token: string,
    private phoneNumberId: string,
    private apiVersion = process.env.WHATSAPP_API_VERSION ?? "v21.0",
  ) {}
  async send(toWaId: string, body: string) {
    const to = toWaId.replace(/\D/g, "");
    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: body.slice(0, 4096) },
      }),
    });
    if (!res.ok) throw new Error(`WhatsApp send failed: ${res.status} ${await res.text()}`);
  }
}

export function createWhatsAppProvider(): WhatsAppProvider {
  const kind = process.env.WHATSAPP_PROVIDER ?? "mock";
  if (kind === "meta" || kind === "live") {
    const token = process.env.WHATSAPP_TOKEN ?? process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) {
      log.warn("whatsapp live requested but missing token/phone id — using mock");
      return new MockWhatsAppProvider();
    }
    return new MetaWhatsAppProvider(token, phoneNumberId);
  }
  return new MockWhatsAppProvider();
}

export function verifyWhatsAppSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
): { ok: boolean; reason?: string } {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    if (webhookVerifyEnabled()) return { ok: false, reason: "WHATSAPP_APP_SECRET not set" };
    log.warn("whatsapp webhook accepted without verification");
    return { ok: true };
  }
  if (!signatureHeader?.startsWith("sha256=")) {
    if (webhookVerifyEnabled()) return { ok: false, reason: "missing X-Hub-Signature-256" };
    return { ok: true };
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const got = signatureHeader.slice("sha256=".length);
  try {
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
  } catch {
    return { ok: false, reason: "signature compare failed" };
  }
  return { ok: true };
}

/** Meta hub challenge for webhook subscription. */
export function whatsappVerifyChallenge(query: {
  "hub.mode"?: string;
  "hub.verify_token"?: string;
  "hub.challenge"?: string;
}): string | null {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (mode === "subscribe" && expected && token === expected && challenge) return challenge;
  return null;
}

export function parseWhatsAppWebhook(payload: unknown): WhatsAppInbound[] {
  const out: WhatsAppInbound[] = [];
  const body = payload as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          messages?: Array<{
            from?: string;
            id?: string;
            type?: string;
            text?: { body?: string };
          }>;
        };
      }>;
    }>;
  };
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        if (msg.type && msg.type !== "text") continue;
        const from = msg.from ?? "";
        const text = msg.text?.body?.trim() ?? "";
        if (!from || !text) continue;
        out.push({
          fromWaId: from,
          account: accountFromWhatsApp(from),
          text,
          messageId: msg.id,
        });
      }
    }
  }
  return out;
}
