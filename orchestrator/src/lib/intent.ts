import { parseSwapToken, type SwapToken } from "./tokens.js";

export type Intent =
  | { action: "join"; name?: string }
  | { action: "hello" }
  | { action: "set_name"; name: string }
  | { action: "balance" }
  | { action: "deposit" }
  | { action: "send"; amount: number; to: string; memo?: string }
  | { action: "swap"; amount: number; tokenIn: SwapToken; tokenOut: SwapToken }
  | { action: "topup"; amount: number; currency: "EUR" | "USD"; to?: string }
  | { action: "save"; name: string; target: string }
  | { action: "contacts" }
  | { action: "price"; symbol: string }
  | { action: "rate" }
  | { action: "help" }
  | { action: "confirm"; pin?: string }
  | { action: "cancel" }
  | { action: "set_pin"; pin: string }
  | { action: "history" }
  | { action: "claim_name"; name: string }
  | { action: "whois"; name: string }
  | { action: "verify_id"; nationalId: string }
  | { action: "attest_sim" }
  | { action: "identity" }
  | { action: "report_sim" }
  | { action: "callback" }
  | { action: "recover_pin" }
  | { action: "recover_confirm"; code: string; pin: string }
  | { action: "change_pin"; oldPin: string; newPin: string }
  | { action: "set_policy"; spoken: string }
  | { action: "show_policy" }
  | { action: "clear_policy" }
  | { action: "confirm_policy"; pin?: string }
  | { action: "standing"; amount: number; to: string; cadence: "monthly" | "weekly" }
  | { action: "list_standing" }
  | { action: "cancel_standing"; id: number }
  | { action: "lock_savings"; amount: number; until: string }
  | { action: "list_locks" }
  | { action: "shop"; query: string }
  | { action: "buy"; handleOrIndex: string }
  | { action: "unknown"; raw: string };

/** "send 10 usdt to +1555…" / "pay 5 dollars to this number 555…" / "send 2 to alice.hotline" */
const SEND_RE =
  /(?:send|transfer|pay)\s+(\d+(?:\.\d+)?)\s*(?:usdt|usdc|usd|dollars?|bucks?)?\s+(?:to\s+)?(?:this\s+number\s+)?([+\d][\d\s().-]{6,}|[+\w.@-]+)/i;
const JOIN_RE = /(?:join|register|signup|sign up)(?:\s+(\w+))?/i;
const NAME_RE = /(?:my name is|i(?:'m| am)|call me|this is)\s+([a-z][a-z'-]{1,30})/i;
const PRICE_RE =
  /(?:price|worth|cost|how much)\s+(?:is\s+|of\s+)?(bitcoin|btc|ethereum|eth|solana|sol|usdc)?/i;
const SAVE_RE = /save\s+(\w+)\s+([+\d\w.]+)/i;
const PIN_RE = /(?:pin|set pin)\s*[:=]?\s*(\d{4,6})/i;
const CONFIRM_RE = /^(confirm|yes|y|ok|okay)\b(?:\s+(\d{4,6}))?/i;
const CLAIM_RE = /^(?:claim|name)\s+([a-z][a-z0-9-]{1,31})(?:\.hotline)?\s*$/i;
const WHOIS_RE = /^(?:whois|lookup|resolve)\s+([a-z][a-z0-9.-]{1,40})\s*$/i;
const VERIFY_RE = /^(?:verify(?:\s+id)?|id)\s+([A-Za-z0-9-]{4,32})\s*$/i;
const ATTEST_RE = /^(?:attest(?:\s+sim)?|sim\s+attest)\b/i;
const IDENTITY_RE = /^(?:identity|tier|limits)\b/i;
const REPORT_SIM_RE = /^(?:report\s+sim(?:\s+change)?|sim\s+swap|port\s+alert)\b/i;
const CALLBACK_RE = /^(?:callback|call\s+me\s+back|verify\s+callback)\b/i;
const RECOVER_RE = /^(?:recover(?:\s+pin)?|forgot\s+pin)\b/i;
const RECOVER_CONFIRM_RE =
  /^recover\s+confirm\s+(\d{4,8})\s+(\d{4,6})\s*$/i;
const CHANGE_PIN_RE = /^change\s+pin\s+(\d{4,6})\s+(\d{4,6})\s*$/i;
const POLICY_SET_RE =
  /^(?:policy|rule)\s*:?\s*(.+)$/i;
const POLICY_NEVER_RE =
  /^never\s+send\b.+/i;
const STANDING_RE =
  /(?:send|stand(?:ing)?(?:\s+order)?)\s+(\d+(?:\.\d+)?)\s*(?:usdt|usdc|usd|dollars?)?\s+to\s+([+\w.@-]+)\s+(?:every\s+month|monthly|on\s+the\s+first(?:\s+of\s+every\s+month)?|every\s+week|weekly)/i;
const LOCK_RE =
  /(?:lock|save)\s+(\d+(?:\.\d+)?)\s*(?:usdt|usdc|usd|dollars?)?\s+(?:a\s+week\s+)?until\s+(\d{4}-\d{2}-\d{2}|january|february|march|april|may|june|july|august|september|october|november|december)/i;
const RATE_RE = /^(?:rate|dial\s*a?\s*rate|reference\s+rate|fx\s+rate)\b/i;
const SHOP_RE = /^(?:shop(?:\s+for)?)\s+(.+)$/i;
const BUY_RE = /^(?:buy|order|purchase)\s+([a-z0-9][a-z0-9-]{1,60}|\d{1,2})\s*$/i;
/** "swap 1 dollar to euro" / "exchange 5 euro for bitcoin" (USDC spoken as dollar) */
const TOKEN_WORD =
  "(?:circle\\s+)?(?:bitcoin|btc|usdc|usd|usdt|eurc|eur|euros?|cirbtc|circbtc|dollars?|bucks?)";
const SWAP_AMT = "(?:\\d+(?:\\.\\d+)?|a|an)";
const SWAP_RE = new RegExp(
  `(?:swap|exchange|convert|change)\\s+(${SWAP_AMT})\\s+(${TOKEN_WORD})\\s+(?:to|for|into)\\s+(${TOKEN_WORD})\\b`,
  "i",
);
/** "swap 1 to euro" — amount only, assume dollars */
const SWAP_SHORT_RE = new RegExp(
  `(?:swap|exchange|convert|change)\\s+(${SWAP_AMT})\\s+(?:to|for|into)\\s+(${TOKEN_WORD})\\b`,
  "i",
);
/**
 * Airtime:
 *  "top up 10 euro airtime"
 *  "buy 5 dollars airtime for +353…"
 *  "airtime 10 euro"
 *  "reload 5 airtime on this number"
 */
const TOPUP_RE =
  /(?:(?:top\s*up|buy|get|reload|purchase)\s+)?(\d+(?:\.\d+)?|a|an)\s*(euro|euros|eur|dollar|dollars|usd|usdc|bucks?)?\s*(?:of\s+)?airtime(?:\s+(?:for|to|on)\s+(.+))?/i;
const TOPUP_ALT_RE =
  /(?:top\s*up|reload|recharge)\s+(\d+(?:\.\d+)?|a|an)\s*(euro|euros|eur|dollar|dollars|usd|usdc)?(?:\s+(?:for|to|on)\s+(.+))?/i;
const TOPUP_LEAD_RE =
  /^airtime\s+(\d+(?:\.\d+)?|a|an)\s*(euro|euros|eur|dollar|dollars|usd|usdc|bucks?)?(?:\s+(?:for|to|on)\s+(.+))?/i;

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
    !/^(yes|no|ok|okay|cancel|help|balance|deposit|history|hi|hey|hello|start|identity|attest)$/i.test(
      t,
    )
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
  if (RATE_RE.test(t) || /^(what('s| is)\s+)?(the\s+)?(usd|usdc|dollar)\s+rate\b/i.test(t)) {
    return { action: "rate" };
  }

  const topupEarly =
    t.match(TOPUP_LEAD_RE) ||
    t.match(TOPUP_RE) ||
    (/airtime|top\s*up|reload|recharge/i.test(t) ? t.match(TOPUP_ALT_RE) : null);
  if (topupEarly) {
    const amount = (() => {
      const s = topupEarly[1]!.toLowerCase();
      if (s === "a" || s === "an") return 1;
      return Number(topupEarly[1]);
    })();
    const curRaw = (topupEarly[2] ?? "euro").toLowerCase();
    const currency: "EUR" | "USD" = /dollar|usd|usdc|buck/.test(curRaw) ? "USD" : "EUR";
    const toRaw = topupEarly[3]?.trim();
    const to =
      toRaw && !/^(this|my|the)\s+number$/i.test(toRaw) ? cleanPayee(toRaw) : undefined;
    if (amount > 0) {
      return { action: "topup", amount, currency, to };
    }
  }

  const shop = t.match(SHOP_RE);
  if (shop && !/^shop\s+pay\b/i.test(t)) {
    return { action: "shop", query: shop[1]!.trim() };
  }
  const buy = t.match(BUY_RE);
  if (buy) return { action: "buy", handleOrIndex: buy[1]!.toLowerCase() };
  if (/^buy\b/i.test(t) || /^shop\b/i.test(t)) {
    return { action: "shop", query: t.replace(/^(?:buy|shop)\s+/i, "").trim() || "tee" };
  }

  if (
    /^balance\b/i.test(t) ||
    /\b(my\s+)?balance\b/i.test(t) ||
    /what(?:'s| is|s)?\s+(?:my\s+)?balance\b/i.test(t) ||
    /check\s+(?:my\s+)?balance\b/i.test(t) ||
    /how much.*(have|left)/i.test(t) ||
    /how\s+much\s+(?:do\s+i\s+have|money|usdc|usdt)\b/i.test(t)
  ) {
    return { action: "balance" };
  }
  if (/^deposit\b/i.test(t) || /wallet address/i.test(t)) return { action: "deposit" };
  if (/^contacts\b/i.test(t)) return { action: "contacts" };
  if (/^(history|ledger|txs?|transactions)\b/i.test(t)) return { action: "history" };

  if (/^show\s+policy\b/i.test(t) || /^my\s+rules?\b/i.test(t)) return { action: "show_policy" };
  if (/^clear\s+policy\b/i.test(t) || /^revoke\s+rules?\b/i.test(t)) {
    return { action: "clear_policy" };
  }
  if (/^confirm\s+policy\b/i.test(t)) {
    const pin = t.match(/confirm\s+policy\s+(\d{4,6})/i);
    return { action: "confirm_policy", pin: pin?.[1] };
  }
  const policySet = t.match(POLICY_SET_RE);
  if (policySet) return { action: "set_policy", spoken: policySet[1]!.trim() };
  if (POLICY_NEVER_RE.test(t)) return { action: "set_policy", spoken: t };

  if (/^list\s+standing\b/i.test(t) || /^standing\s+orders?\b/i.test(t)) {
    return { action: "list_standing" };
  }
  const cancelStand = t.match(/^cancel\s+standing\s+(\d+)\s*$/i);
  if (cancelStand) return { action: "cancel_standing", id: Number(cancelStand[1]) };

  if (/^list\s+locks?\b/i.test(t) || /^my\s+savings\b/i.test(t)) return { action: "list_locks" };

  const standing = t.match(STANDING_RE);
  if (standing) {
    const cadence = /week/i.test(standing[0]!) ? "weekly" : "monthly";
    return {
      action: "standing",
      amount: Number(standing[1]),
      to: cleanPayee(standing[2]!),
      cadence,
    };
  }

  const lock = t.match(LOCK_RE);
  if (lock) {
    return { action: "lock_savings", amount: Number(lock[1]), until: lock[2]!.toLowerCase() };
  }

  if (ATTEST_RE.test(t)) return { action: "attest_sim" };
  if (IDENTITY_RE.test(t)) return { action: "identity" };
  if (REPORT_SIM_RE.test(t)) return { action: "report_sim" };
  if (CALLBACK_RE.test(t)) return { action: "callback" };
  if (RECOVER_RE.test(t) && !/^recover\s+confirm/i.test(t)) return { action: "recover_pin" };

  const recoverConfirm = t.match(RECOVER_CONFIRM_RE);
  if (recoverConfirm) {
    return { action: "recover_confirm", code: recoverConfirm[1], pin: recoverConfirm[2] };
  }
  const changePin = t.match(CHANGE_PIN_RE);
  if (changePin) {
    return { action: "change_pin", oldPin: changePin[1], newPin: changePin[2] };
  }

  const claim = t.match(CLAIM_RE);
  if (claim) return { action: "claim_name", name: claim[1].toLowerCase() };

  const whois = t.match(WHOIS_RE);
  if (whois) return { action: "whois", name: whois[1].toLowerCase() };

  const verify = t.match(VERIFY_RE);
  if (verify) return { action: "verify_id", nationalId: verify[1] };

  const join = t.match(JOIN_RE);
  if (join) return { action: "join", name: join[1]?.toLowerCase() };

  const save = t.match(SAVE_RE);
  if (save) return { action: "save", name: save[1].toLowerCase(), target: save[2] };

  const swapAmt = (raw: string) => {
    const s = raw.toLowerCase();
    if (s === "a" || s === "an") return 1;
    return Number(raw);
  };

  const swap = t.match(SWAP_RE);
  if (swap) {
    const tokenIn = parseSwapToken(swap[2]!);
    const tokenOut = parseSwapToken(swap[3]!);
    const amount = swapAmt(swap[1]!);
    if (tokenIn && tokenOut && tokenIn !== tokenOut && amount > 0) {
      return { action: "swap", amount, tokenIn, tokenOut };
    }
  }
  const swapShort = t.match(SWAP_SHORT_RE);
  if (swapShort) {
    const tokenOut = parseSwapToken(swapShort[2]!);
    const amount = swapAmt(swapShort[1]!);
    if (tokenOut && tokenOut !== "USDC" && amount > 0) {
      return { action: "swap", amount, tokenIn: "USDC", tokenOut };
    }
  }

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
