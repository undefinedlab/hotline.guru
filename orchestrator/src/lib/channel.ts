/**
 * Channel identity → hotline account key.
 * WhatsApp uses the same E.164 phone as SMS (phone = account).
 * Telegram has no phone by default → tg:<chat_id> until LINK (future).
 */
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
