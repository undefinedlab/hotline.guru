import { addLedger } from "./db.js";
import {
  discoverMarketplace,
  payMarketplaceUrl,
  resolveAlias,
  type MarketplaceResult,
} from "./marketplaceCatalog.js";

const PRICE_URL =
  process.env.PRICE_SERVICE_URL ?? "https://api.aisa.one/apis/v2/coingecko/simple/price";

export type { MarketplaceResult };

/** Fetch BTC/ETH price — live via circle services pay when possible, else public CoinGecko. */
export async function fetchCryptoPrice(symbol: string, phone: string): Promise<MarketplaceResult> {
  const id = symbol.toLowerCase();
  const url = `${PRICE_URL}?ids=${encodeURIComponent(id)}&vs_currencies=usd`;

  const live = await payMarketplaceUrl({
    url,
    phone,
    method: "GET",
    kind: "nanopay:price",
    maxAmount: process.env.X402_MAX_PRICE ?? "0.01",
  });
  if (live.ok && live.mode === "live") {
    return {
      ok: true,
      mode: "live",
      summary: formatPriceSummary(id, live.raw),
      raw: live.raw,
      url,
    };
  }

  try {
    const free = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`;
    const res = await fetch(free);
    const data = (await res.json()) as Record<string, { usd?: number }>;
    await addLedger({
      phone,
      kind: "nanopay:price",
      amount_usdc: 0,
      meta: JSON.stringify({ url: free, mode: "public-fallback" }),
    });
    const usd = data[id]?.usd;
    if (usd == null) {
      return { ok: false, mode: "public", summary: `No price for ${id}` };
    }
    return {
      ok: true,
      mode: "public",
      summary: `${id} is about $${usd.toLocaleString()} USD`,
      raw: data,
    };
  } catch (e) {
    return { ok: false, mode: "mock", summary: `Price lookup failed: ${String(e)}` };
  }
}

function formatPriceSummary(id: string, parsed: unknown): string {
  try {
    const s = JSON.stringify(parsed);
    const m = s.match(/"usd"\s*:\s*([0-9.]+)/i);
    if (m) return `${id} is about $${Number(m[1]).toLocaleString()} USD (x402 paid)`;
  } catch {
    /* ignore */
  }
  return `Got price data for ${id}`;
}

export async function phoneFraudLookup(phoneNumber: string): Promise<MarketplaceResult> {
  const { url, method } = resolveAlias("fraud");
  const live = await payMarketplaceUrl({
    url,
    phone: phoneNumber,
    method,
    data: { phoneNumber },
    chain: process.env.FRAUD_PAY_CHAIN ?? "MATIC",
    kind: "nanopay:fraud",
    maxAmount: process.env.X402_MAX_FRAUD ?? "0.05",
  });
  if (live.ok) {
    return { ok: true, mode: live.mode, summary: "Fraud lookup complete", raw: live.raw, url };
  }
  if (live.mode === "mock") {
    return {
      ok: true,
      mode: "mock",
      summary: "Fraud lookup skipped (set MARKETPLACE_LIVE=1 + Gateway to enable BlockRun)",
    };
  }
  return { ok: false, mode: live.mode, summary: live.summary, url };
}

export async function researchQuery(question: string, phone: string): Promise<MarketplaceResult> {
  const { url, method } = resolveAlias("research");
  const live = await payMarketplaceUrl({
    url,
    phone,
    method,
    data: { messages: [{ role: "user", content: question }] },
    kind: "nanopay:research",
    maxAmount: process.env.X402_MAX_RESEARCH ?? "0.05",
  });
  if (live.ok && live.mode === "live") {
    const text = extractAnswer(live.raw) ?? live.summary;
    return { ok: true, mode: "live", summary: text, raw: live.raw, url };
  }
  return {
    ok: false,
    mode: live.mode,
    summary:
      live.mode === "mock"
        ? `Research needs MARKETPLACE_LIVE=1. Question was: ${question.slice(0, 80)}`
        : live.summary,
    url,
  };
}

export async function outboundMarketplaceCall(opts: {
  to: string;
  task: string;
  phone: string;
  provider?: "stablephone" | "bland";
}): Promise<MarketplaceResult> {
  const alias = opts.provider === "bland" ? "call_bland" : "call";
  const { url, method } = resolveAlias(alias);
  const data =
    alias === "call"
      ? { phone_number: opts.to, task: opts.task }
      : { to: opts.to, task: opts.task };
  return payMarketplaceUrl({
    url,
    phone: opts.phone,
    method,
    data,
    kind: "nanopay:call",
    maxAmount: process.env.X402_MAX_CALL ?? "0.60",
  });
}

function extractAnswer(raw: unknown): string | null {
  try {
    const s = JSON.stringify(raw);
    const choices = (raw as { choices?: { message?: { content?: string } }[] })?.choices;
    if (choices?.[0]?.message?.content) return choices[0].message.content.slice(0, 500);
    const m = s.match(/"content"\s*:\s*"((?:\\.|[^"\\]){10,400})"/);
    if (m) return m[1]!.replace(/\\n/g, " ").slice(0, 400);
  } catch {
    /* ignore */
  }
  return null;
}

export { discoverMarketplace, payMarketplaceUrl, resolveAlias };
