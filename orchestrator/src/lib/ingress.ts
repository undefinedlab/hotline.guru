/**
 * Unified chat ingress — WhatsApp / Telegram / SMS all hit handleMessage.
 */
import { handleMessage, type HandleResult } from "./pipeline.js";
import { canReceiveSms } from "./channel.js";
import { createSmsProvider, type SmsProvider } from "./sms.js";
import { createTelegramProvider, type TelegramProvider } from "./telegram.js";
import { createWhatsAppProvider, type WhatsAppProvider } from "./whatsapp.js";
import { log } from "./log.js";

export async function handleInboundWhatsApp(
  account: string,
  text: string,
  fromWaId: string,
  wa: WhatsAppProvider = createWhatsAppProvider(),
): Promise<HandleResult> {
  const result = await handleMessage(account, text);
  await wa.send(fromWaId, result.reply);
  return result;
}

export async function handleInboundTelegram(
  account: string,
  text: string,
  chatId: string,
  tg: TelegramProvider = createTelegramProvider(),
): Promise<HandleResult> {
  const result = await handleMessage(account, text);
  await tg.send(chatId, result.reply);
  return result;
}

/** Optional: also mirror replies to SMS when account is a real phone (WA). */
export async function maybeMirrorSms(
  account: string,
  body: string,
  sms: SmsProvider = createSmsProvider(),
): Promise<void> {
  if (!canReceiveSms(account)) return;
  if (process.env.MIRROR_CHAT_TO_SMS !== "1") return;
  try {
    await sms.send(account, body);
  } catch (e) {
    log.warn("sms mirror failed", { err: String(e) });
  }
}
