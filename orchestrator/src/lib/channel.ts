/**
 * Channel identity → hotline account key.
 * WhatsApp uses the same E.164 phone as SMS (phone = account).
 * Telegram is an alias until Share-contact links chatId → E.164.
 */
import {
  linkChannelAccount,
  normalizePhone,
  resolveLinkedPhone,
  deleteProvisionalTelegramUser,
  getUser,
  countLedgerEntries,
} from "./db.js";
import { ensureWallet } from "./wallets.js";
import { log } from "./log.js";

export type IngressChannel = "sms" | "whatsapp" | "telegram" | "api" | "voice";

export function isTelegramAccount(account: string): boolean {
  return account.startsWith("tg:");
}

export function isPhoneAccount(account: string): boolean {
  return account.startsWith("+") && !isTelegramAccount(account);
}

/** Prefer for SMS receipts / fraud lookups that need a real MSISDN. */
export function canReceiveSms(account: string): boolean {
  return isPhoneAccount(account) && /^\+\d{8,15}$/.test(account);
}

export function accountFromWhatsApp(waId: string): string {
  const digits = waId.replace(/\D/g, "");
  if (!digits) throw new Error("empty WhatsApp id");
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export function accountFromTelegram(chatId: string | number): string {
  const id = String(chatId).replace(/[^\d-]/g, "");
  if (!id) throw new Error("empty Telegram chat id");
  return `tg:${id}`;
}

export function telegramChatIdFromAccount(account: string): string {
  return account.replace(/^tg:/i, "");
}

export function parseChannelAccount(raw: string): { channel: IngressChannel; account: string } {
  const t = raw.trim();
  if (/^(tg|telegram):/i.test(t)) {
    return { channel: "telegram", account: accountFromTelegram(t.replace(/^(tg|telegram):/i, "")) };
  }
  if (/^(wa|whatsapp):/i.test(t)) {
    return { channel: "whatsapp", account: accountFromWhatsApp(t.replace(/^(wa|whatsapp):/i, "")) };
  }
  return { channel: "sms", account: t };
}

/** Resolve tg: alias → linked E.164, or null if not linked yet. */
export async function resolveCanonicalAccount(account: string): Promise<string | null> {
  const a = normalizePhone(account);
  if (isPhoneAccount(a)) return a;
  if (!isTelegramAccount(a)) return a;
  const chatId = telegramChatIdFromAccount(a);
  return resolveLinkedPhone("telegram", chatId);
}

export type LinkTelegramResult =
  | { ok: true; phone: string; reply: string }
  | { ok: false; reply: string };

/**
 * Prove phone via Telegram Share-contact, then E.164 owns wallet/PIN/NS.
 */
export async function linkTelegramToPhone(
  chatId: string | number,
  contactPhone: string,
): Promise<LinkTelegramResult> {
  const ext = String(chatId).replace(/[^\d-]/g, "");
  const phone = normalizePhone(contactPhone);
  if (!ext) return { ok: false, reply: "Could not read your Telegram chat. Try /start again." };
  if (!canReceiveSms(phone)) {
    return {
      ok: false,
      reply: "That does not look like a mobile number. Share the phone on your Telegram account.",
    };
  }

  const tgAccount = accountFromTelegram(ext);
  const existingTg = await getUser(tgAccount);
  if (existingTg?.hotline_name) {
    const phoneUser = await getUser(phone);
    if (phoneUser?.hotline_name && phoneUser.hotline_name !== existingTg.hotline_name) {
      log.warn("telegram link refused, HotlineNS conflict", {
        tg: tgAccount,
        phone,
        tgNs: existingTg.hotline_name,
        phoneNs: phoneUser.hotline_name,
      });
      return {
        ok: false,
        reply: `This Telegram chat already claimed ${existingTg.hotline_name}.hotline under a different identity. Contact support to merge.`,
      };
    }
  }
  if (existingTg && (await countLedgerEntries(tgAccount)) > 0) {
    log.warn("telegram link refused, provisional tg wallet has ledger", { tg: tgAccount, phone });
    return {
      ok: false,
      reply: "This Telegram chat already has a separate wallet history. Contact support to merge onto your phone number.",
    };
  }

  await ensureWallet(phone);
  await linkChannelAccount("telegram", ext, phone);

  if (existingTg) {
    const dropped = await deleteProvisionalTelegramUser(tgAccount);
    log.info("telegram provisional user cleanup", { tg: tgAccount, dropped });
  }

  log.info("telegram linked to phone", { chatId: ext, phone });
  return {
    ok: true,
    phone,
    reply: `Linked ${phone}. Your wallet, PIN and name live on this number, same as calling the hotline.`,
  };
}
