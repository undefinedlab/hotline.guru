/**
 * Telegram Bot API ingress.
 * Lab: TELEGRAM_PROVIDER=mock logs outbound.
 * Live: TELEGRAM_BOT_TOKEN (+ optional TELEGRAM_WEBHOOK_SECRET).
 */
import { accountFromTelegram } from "./channel.js";
import { log, safeEqualStr } from "./log.js";
import { webhookVerifyEnabled } from "./webhooks.js";

export type TelegramInbound = {
  account: string;
  text: string;
  chatId: string;
  messageId?: number;
  username?: string;
};

export interface TelegramProvider {
  name: string;
  send(chatId: string, body: string): Promise<void>;
}

export class MockTelegramProvider implements TelegramProvider {
  name = "mock";
  sent: { to: string; body: string }[] = [];
  async send(to: string, body: string) {
    this.sent.push({ to, body });
    console.log(`[telegram:mock] → ${to}: ${body}`);
  }
}

export class TelegramBotProvider implements TelegramProvider {
  name = "bot";
  constructor(private token: string) {}
  async send(chatId: string, body: string) {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: body.slice(0, 4096),
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) throw new Error(`Telegram send failed: ${res.status} ${await res.text()}`);
  }
}

export function createTelegramProvider(): TelegramProvider {
  const kind = process.env.TELEGRAM_PROVIDER ?? "mock";
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if ((kind === "bot" || kind === "live") && token) {
    return new TelegramBotProvider(token);
  }
  if (kind === "bot" || kind === "live") {
    log.warn("telegram live requested but TELEGRAM_BOT_TOKEN missing — using mock");
  }
  return new MockTelegramProvider();
}

export function verifyTelegramSecret(
  header: string | null | undefined,
): { ok: boolean; reason?: string } {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    if (webhookVerifyEnabled()) return { ok: false, reason: "TELEGRAM_WEBHOOK_SECRET not set" };
    log.warn("telegram webhook accepted without verification");
    return { ok: true };
  }
  if (!header) {
    if (webhookVerifyEnabled()) return { ok: false, reason: "missing X-Telegram-Bot-Api-Secret-Token" };
    return { ok: true };
  }
  if (!safeEqualStr(header, secret)) return { ok: false, reason: "bad telegram secret" };
  return { ok: true };
}

export function parseTelegramUpdate(payload: unknown): TelegramInbound | null {
  const u = payload as {
    message?: {
      message_id?: number;
      text?: string;
      chat?: { id?: number | string };
      from?: { username?: string };
    };
    edited_message?: {
      message_id?: number;
      text?: string;
      chat?: { id?: number | string };
      from?: { username?: string };
    };
  };
  const msg = u.message ?? u.edited_message;
  if (!msg?.chat?.id) return null;
  const text = msg.text?.trim() ?? "";
  if (!text) return null;
  const chatId = String(msg.chat.id);
  return {
    chatId,
    account: accountFromTelegram(chatId),
    text,
    messageId: msg.message_id,
    username: msg.from?.username,
  };
}
