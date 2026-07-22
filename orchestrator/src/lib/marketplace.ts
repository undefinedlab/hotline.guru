import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { addLedger } from "./db.js";

const execFileAsync = promisify(execFile);

const PRICE_URL =
  process.env.PRICE_SERVICE_URL ?? "https://api.aisa.one/apis/v2/coingecko/simple/price";
const OPERATOR = process.env.OPERATOR_ARC_ADDRESS ?? "";

export type MarketplaceResult = {
  ok: boolean;
  summary: string;
  raw?: unknown;
  mode: "live" | "public" | "mock";
};

/** Fetch BTC/ETH price — live via circle services pay when possible, else public CoinGecko mock-free fallback. */
export async function fetchCryptoPrice(symbol: string, phone: string): Promise<MarketplaceResult> {
  const id = symbol.toLowerCase();
  const url = `${PRICE_URL}?ids=${encodeURIComponent(id)}&vs_currencies=usd`;

  // Prefer Circle CLI pay (x402) when operator wallet + gateway ready
  if (process.env.MARKETPLACE_LIVE === "1" && OPERATOR) {
    try {
      const chain = process.env.MARKETPLACE_PAY_CHAIN ?? "BASE";
      const { stdout } = await execFileAsync(
        "circle",
        [
          "services",
          "pay",
          url,
          "--address",
          OPERATOR,
          "--chain",
          chain,
          "--output",
          "json",
        ],
        { timeout: 60_000, maxBuffer: 2_000_000 },
      );
      const parsed = JSON.parse(stdout);
      addLedger({
        phone,
        kind: "nanopay:price",
        amount_usdc: 0.008,
        meta: JSON.stringify({ url, live: true }),
      });
      return {
        ok: true,
        mode: "live",
        summary: formatPriceSummary(id, parsed),
        raw: parsed,
      };
    } catch (err) {
      // fall through to free public endpoint for demo resilience
      console.warn("circle services pay failed, falling back:", err);
    }
  }

  // Free public CoinGecko (demo fallback — not x402). Still records nanopay intent ledger at $0.
  try {
    const free = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`;
    const res = await fetch(free);
    const data = (await res.json()) as Record<string, { usd?: number }>;
    addLedger({
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
  // BlockRun fraud endpoint requires Gateway on Polygon — mock structure for JOIN soft-check
  if (process.env.MARKETPLACE_LIVE === "1" && OPERATOR) {
    try {
      const url = "https://nano.blockrun.ai/api/v1/phone/lookup/fraud";
      const { stdout } = await execFileAsync(
        "circle",
        [
          "services",
          "pay",
          url,
          "--address",
          OPERATOR,
          "--chain",
          "MATIC",
          "-X",
          "POST",
          "--data",
          JSON.stringify({ phoneNumber }),
          "--output",
          "json",
        ],
        { timeout: 60_000 },
      );
      return { ok: true, mode: "live", summary: "Fraud lookup complete", raw: JSON.parse(stdout) };
    } catch (e) {
      return { ok: false, mode: "live", summary: `Fraud lookup unavailable: ${String(e)}` };
    }
  }
  return {
    ok: true,
    mode: "mock",
    summary: "Fraud lookup skipped (set MARKETPLACE_LIVE=1 + Gateway on Polygon to enable)",
  };
}
