/**
 * Telegram Bot API ingress.
 * Lab: TELEGRAM_PROVIDER=mock logs outbound.
 * Live: TELEGRAM_BOT_TOKEN (+ optional TELEGRAM_WEBHOOK_SECRET).
 *
 * Phone ownership: ReplyKeyboard request_contact → message.contact (own number only).
 */
import { accountFromTelegram } from "./channel.js";
import { normalizePhone } from "./db.js";
import { log, safeEqualStr } from "./log.js";
import { webhookVerifyEnabled } from "./webhooks.js";

export type TelegramInbound = {
  account: string;
  text: string;
  chatId: string;
  messageId?: number;
  username?: string;
  /** Own contact shared via request_contact (E.164). */
  contactPhone?: string;
};

export type TelegramSendOpts = {
  /** Ask user to share their Telegram phone number. */
  requestContact?: boolean;
  /** Clear the share-contact keyboard after link. */
  removeKeyboard?: boolean;
};

export interface TelegramProvider {
  name: string;
  send(chatId: string, body: string, opts?: TelegramSendOpts): Promise<void>;
}

export class MockTelegramProvider implements TelegramProvider {
  name = "mock";
  sent: { to: string; body: string; opts?: TelegramSendOpts }[] = [];
  async send(to: string, body: string, opts?: TelegramSendOpts) {
    this.sent.push({ to, body, opts });
    console.log(`[telegram:mock] → ${to}: ${body}${opts?.requestContact ? " [request_contact]" : ""}`);
  }
}

export class TelegramBotProvider implements TelegramProvider {
  name = "bot";
  constructor(private token: string) {}
  async send(chatId: string, body: string, opts?: TelegramSendOpts) {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: body.slice(0, 4096),
      disable_web_page_preview: true,
    };
    if (opts?.requestContact) {
      payload.reply_markup = {
        keyboard: [
          [
            {
              text: "Share my phone number",
              request_contact: true,
            },
          ],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      };
    } else if (opts?.removeKeyboard) {
      payload.reply_markup = { remove_keyboard: true };
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
    log.warn("telegram live requested but TELEGRAM_BOT_TOKEN missing, using mock");
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

type TgMessage = {
  message_id?: number;
  text?: string;
  chat?: { id?: number | string };
  from?: { id?: number | string; username?: string };
  contact?: {
    phone_number?: string;
    user_id?: number | string;
  };
};

function normalizeContactPhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return normalizePhone(digits);
  // Telegram often omits + ; treat as international digits.
  return normalizePhone(`+${digits.replace(/\D/g, "")}`);
}

export function parseTelegramUpdate(payload: unknown): TelegramInbound | null {
  const u = payload as {
    message?: TgMessage;
    edited_message?: TgMessage;
  };
  const msg = u.message ?? u.edited_message;
  if (!msg?.chat?.id) return null;
  const chatId = String(msg.chat.id);
  const fromId = msg.from?.id != null ? String(msg.from.id) : "";

  let contactPhone: string | undefined;
  if (msg.contact?.phone_number) {
    const contactUserId = msg.contact.user_id != null ? String(msg.contact.user_id) : "";
    // Only accept the user's own contact (not a forwarded third-party card).
    if (fromId && contactUserId && contactUserId === fromId) {
      contactPhone = normalizeContactPhone(msg.contact.phone_number);
    } else {
      log.warn("telegram contact rejected, not own number", {
        chatId,
        fromId,
        contactUserId: contactUserId || null,
      });
    }
  }

  const text = msg.text?.trim() ?? "";
  if (!text && !contactPhone) return null;

  return {
    chatId,
    account: accountFromTelegram(chatId),
    text: text || (contactPhone ? "hi" : ""),
    messageId: msg.message_id,
    username: msg.from?.username,
    contactPhone,
  };
}
