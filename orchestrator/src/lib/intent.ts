export type Intent =
  | { action: "join"; name?: string }
  | { action: "hello" }
  | { action: "set_name"; name: string }
  | { action: "balance" }
  | { action: "deposit" }
  | { action: "send"; amount: number; to: string }
  | { action: "save"; name: string; target: string }
  | { action: "contacts" }
  | { action: "price"; symbol: string }
  | { action: "help" }
  | { action: "confirm"; pin?: string }
  | { action: "cancel" }
  | { action: "set_pin"; pin: string }
  | { action: "history" }
  | { action: "unknown"; raw: string };

/** "send 10 usdt to +1555…" / "pay 5 dollars to this number 555…" */
const SEND_RE =
  /(?:send|transfer|pay)\s+(\d+(?:\.\d+)?)\s*(?:usdt|usdc|usd|dollars?|bucks?)?\s+(?:to\s+)?(?:this\s+number\s+)?([+\d][\d\s().-]{6,}|[+\w.@-]+)/i;
const JOIN_RE = /(?:join|register|signup|sign up)(?:\s+(\w+))?/i;
const NAME_RE = /(?:my name is|i(?:'m| am)|call me|this is)\s+([a-z][a-z'-]{1,30})/i;
const PRICE_RE =
  /(?:price|worth|cost|how much)\s+(?:is\s+|of\s+)?(bitcoin|btc|ethereum|eth|solana|sol|usdc)?/i;
const SAVE_RE = /save\s+(\w+)\s+([+\d\w.]+)/i;
const PIN_RE = /(?:pin|set pin)\s*[:=]?\s*(\d{4,6})/i;
const CONFIRM_RE = /^(confirm|yes|y|ok|okay)\b(?:\s+(\d{4,6}))?/i;

function cleanPayee(raw: string): string {
  const t = raw.trim();
  if (/^[+\d][\d\s().-]+$/.test(t) || /^\d{7,15}$/.test(t.replace(/\D/g, ""))) {
    const digits = t.replace(/[^\d+]/g, "");
    if (digits.startsWith("+")) return digits;
    const only = digits.replace(/\D/g, "");
    if (only.length === 10) return `+1${only}`;
    if (only.length === 11 && only.startsWith("1")) return `+${only}`;
    return `+${only}`;
  }
  return t;
}

/** Bare first name when we're waiting for onboarding. */
export function parseNameAnswer(text: string): string | null {
  const t = text.trim();
  const named = t.match(NAME_RE);
  if (named) return named[1];
  if (
    /^[a-z][a-z'-]{1,30}$/i.test(t) &&
    !/^(yes|no|ok|okay|cancel|help|balance|deposit|history|hi|hey|hello|start)$/i.test(t)
  ) {
    return t;
  }
  return null;
}

export function parseIntent(text: string): Intent {
  const t = text.trim();
  if (!t) return { action: "hello" };

  if (/^(hi|hello|hey|start)\s*[!.]*$/i.test(t)) return { action: "hello" };

  if (/^(cancel|no|stop)\b/i.test(t)) return { action: "cancel" };
  const conf = t.match(CONFIRM_RE);
  if (conf) return { action: "confirm", pin: conf[2] };

  const pin = t.match(PIN_RE);
  if (pin) return { action: "set_pin", pin: pin[1] };

  const named = t.match(NAME_RE);
  if (named) return { action: "set_name", name: named[1] };

  if (/^help\b/i.test(t) || /^commands\b/i.test(t)) return { action: "help" };
  if (/^balance\b/i.test(t) || /how much.*(have|left)/i.test(t)) return { action: "balance" };
  if (/^deposit\b/i.test(t) || /wallet address/i.test(t)) return { action: "deposit" };
  if (/^contacts\b/i.test(t)) return { action: "contacts" };
  if (/^(history|ledger|txs?|transactions)\b/i.test(t)) return { action: "history" };

  const join = t.match(JOIN_RE);
  if (join) return { action: "join", name: join[1]?.toLowerCase() };

  const save = t.match(SAVE_RE);
  if (save) return { action: "save", name: save[1].toLowerCase(), target: save[2] };

  const send = t.match(SEND_RE);
  if (send) {
    return { action: "send", amount: Number(send[1]), to: cleanPayee(send[2]) };
  }

  const price = t.match(PRICE_RE);
  if (price || /bitcoin|btc/i.test(t)) {
    const sym = (price?.[1] ?? "bitcoin").toLowerCase();
    const map: Record<string, string> = {
      btc: "bitcoin",
      eth: "ethereum",
      sol: "solana",
    };
    return { action: "price", symbol: map[sym] ?? sym };
  }

  if (/^join$/i.test(t)) return { action: "join" };

  return { action: "unknown", raw: text };
}

export async function parseIntentSmart(text: string): Promise<Intent> {
  if (process.env.INTENT_MODE === "openai" && process.env.OPENAI_API_KEY) {
    return parseIntent(text);
  }
  return parseIntent(text);
}
