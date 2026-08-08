/**
 * Unified chat ingress — WhatsApp / Telegram / SMS all hit handleMessage.
 * Telegram: Share-contact links chat → E.164 before any wallet mint.
 */
import { handleMessage, type HandleResult } from "./pipeline.js";
import {
  canReceiveSms,
  linkTelegramToPhone,
  resolveCanonicalAccount,
} from "./channel.js";
import { createSmsProvider, type SmsProvider } from "./sms.js";
import { createTelegramProvider, type TelegramProvider } from "./telegram.js";
import { createWhatsAppProvider, type WhatsAppProvider } from "./whatsapp.js";
import { log } from "./log.js";

const SHARE_PHONE_PROMPT =
  "Share your phone number to continue. Tap the button below. Same number as when you call the hotline — that number owns your wallet, PIN and name.";

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
  opts?: { contactPhone?: string },
): Promise<HandleResult> {
  if (opts?.contactPhone) {
    const linked = await linkTelegramToPhone(chatId, opts.contactPhone);
    if (!linked.ok) {
      await tg.send(chatId, linked.reply, { requestContact: true });
      return { reply: linked.reply };
    }
    await tg.send(chatId, linked.reply, { removeKeyboard: true });
    const next = await handleMessage(linked.phone, text || "hi");
    await tg.send(chatId, next.reply, { removeKeyboard: true });
    return { ...next, reply: `${linked.reply}\n\n${next.reply}`, data: { ...next.data, linkedPhone: linked.phone } };
  }

  const canonical = await resolveCanonicalAccount(account);
  if (!canonical) {
    log.info("telegram unlinked, requesting contact", { chatId });
    await tg.send(chatId, SHARE_PHONE_PROMPT, { requestContact: true });
    return { reply: SHARE_PHONE_PROMPT, data: { needsPhoneLink: true } };
  }

  const result = await handleMessage(canonical, text);
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
