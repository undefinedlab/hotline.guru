/**
 * Circle Agent Marketplace — discovery + pay helpers.
 * Catalog: https://agents.circle.com/services
 * Discovery: GET https://api.circle.com/v2/x402/discovery/resources
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { addLedger } from "./db.js";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

const DISCOVERY =
  process.env.X402_DISCOVERY_URL ??
  "https://api.circle.com/v2/x402/discovery/resources";

const OPERATOR = process.env.OPERATOR_ARC_ADDRESS ?? "";

/** Curated aliases agents can invoke without knowing raw URLs. */
export const MARKETPLACE_ALIASES = {
  price: {
    url: process.env.PRICE_SERVICE_URL ?? "https://api.aisa.one/apis/v2/coingecko/simple/price",
    method: "GET" as const,
    description: "CoinGecko prices via AIsa (x402)",
    category: "FINANCIAL_ANALYSIS",
  },
  research: {
    url: process.env.RESEARCH_SERVICE_URL ?? "https://api.aisa.one/apis/v2/perplexity/sonar",
    method: "POST" as const,
    description: "Perplexity Sonar search+answer via AIsa",
    category: "WEB_SEARCH_RESEARCH",
  },
  research_pro: {
    url: "https://api.aisa.one/apis/v2/perplexity/sonar-pro",
    method: "POST" as const,
    description: "Perplexity Sonar Pro",
    category: "WEB_SEARCH_RESEARCH",
  },
  fraud: {
    url: "https://nano.blockrun.ai/api/v1/phone/lookup/fraud",
    method: "POST" as const,
    description: "BlockRun SIM-swap / call-forward fraud signals",
    category: "INFRASTRUCTURE",
  },
  carrier: {
    url: "https://nano.blockrun.ai/api/v1/phone/lookup",
    method: "POST" as const,
    description: "BlockRun carrier + line type lookup",
    category: "INFRASTRUCTURE",
  },
  call: {
    url: process.env.OUTBOUND_CALL_URL ?? "https://stablephone.dev/api/call",
    method: "POST" as const,
    description: "StablePhone outbound AI call (~$0.54)",
    category: "INFRASTRUCTURE",
  },
  call_bland: {
    url: "https://nano.blockrun.ai/api/v1/voice/call",
    method: "POST" as const,
    description: "BlockRun Bland.ai outbound conversation",
    category: "INFRASTRUCTURE",
  },
  fx: {
    url: "https://nano.blockrun.ai/api/v1/fx/price/{symbol}",
    method: "GET" as const,
    description: "BlockRun FX spot rate",
    category: "FINANCIAL_ANALYSIS",
  },
  shopping: {
    url: "https://stableenrich.dev/api/serper/shopping",
    method: "GET" as const,
    description: "Google Shopping search via StableEnrich (x402)",
    category: "WEB_SEARCH_RESEARCH",
  },
  amazon: {
    url: "https://np.orthogonal.com/scrapecreators/v1/amazon/shop",
    method: "GET" as const,
    description: "Amazon product search via Orthogonal nanopay proxy",
    category: "WEB_SEARCH_RESEARCH",
  },
} as const;

export type MarketplaceAlias = keyof typeof MARKETPLACE_ALIASES;

export type MarketplaceResult = {
  ok: boolean;
  summary: string;
  raw?: unknown;
  mode: "live" | "public" | "mock" | "discovery";
  url?: string;
};

function marketplaceLive(): boolean {
  return process.env.MARKETPLACE_LIVE === "1" && Boolean(OPERATOR);
}

function payChain(): string {
  return process.env.MARKETPLACE_PAY_CHAIN ?? "BASE";
}

/** Discover services on Circle Agent Marketplace (no payment). */
export async function discoverMarketplace(opts: {
  query?: string;
  limit?: number;
  category?: string;
}): Promise<MarketplaceResult> {
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 50);
  const params = new URLSearchParams({
    siwx: "false",
    limit: String(limit),
  });
  if (opts.query) params.set("query", opts.query);
  try {
    const res = await fetch(`${DISCOVERY}?${params}`);
    if (!res.ok) {
      return {
        ok: false,
        mode: "discovery",
        summary: `Discovery HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      items?: {
        resource: string;
        metadata?: {
          description?: string;
          provider?: { name?: string; category?: string };
        };
      }[];
      pagination?: { total?: number };
    };
    let items = data.items ?? [];
    if (opts.category) {
      const cat = opts.category.toUpperCase();
      items = items.filter((i) =>
        (i.metadata?.provider?.category ?? "").toUpperCase().includes(cat),
      );
    }
    const lines = items.slice(0, limit).map((i) => {
      const name = i.metadata?.provider?.name ?? "?";
      const desc = i.metadata?.description ?? "";
      return `${name}: ${i.resource}${desc ? `, ${desc.slice(0, 80)}` : ""}`;
    });
    return {
      ok: true,
      mode: "discovery",
      summary: `Found ${data.pagination?.total ?? items.length} services. Top: ${lines.slice(0, 5).join(" | ") || "none"}`,
      raw: { total: data.pagination?.total, items: items.slice(0, limit) },
    };
  } catch (e) {
    return { ok: false, mode: "discovery", summary: `Discovery failed: ${String(e)}` };
  }
}

/** Pay an arbitrary x402 URL via Circle CLI (when MARKETPLACE_LIVE=1). */
export async function payMarketplaceUrl(opts: {
  url: string;
  phone: string;
  method?: "GET" | "POST" | "PUT";
  data?: unknown;
  chain?: string;
  maxAmount?: string;
  kind?: string;
}): Promise<MarketplaceResult> {
  if (!marketplaceLive()) {
    return {
      ok: false,
      mode: "mock",
      summary:
        "Marketplace pay disabled, set MARKETPLACE_LIVE=1 + OPERATOR_ARC_ADDRESS + funded Gateway",
      url: opts.url,
    };
  }

  const args = [
    "services",
    "pay",
    opts.url,
    "--address",
    OPERATOR,
    "--chain",
    opts.chain ?? payChain(),
    "--output",
    "json",
  ];
  if (opts.maxAmount) {
    args.push("--max-amount", opts.maxAmount);
  }
  if (opts.method && opts.method !== "GET") {
    args.push("-X", opts.method);
  }
  if (opts.data != null) {
    args.push("--data", JSON.stringify(opts.data));
  }

  try {
    const { stdout } = await execFileAsync("circle", args, {
      timeout: 90_000,
      maxBuffer: 4_000_000,
    });
    let parsed: unknown = stdout;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      /* keep text */
    }
    await addLedger({
      phone: opts.phone,
      kind: opts.kind ?? "nanopay:marketplace",
      amount_usdc: Number(opts.maxAmount ?? 0.01),
      meta: JSON.stringify({ url: opts.url, live: true }),
    });
    return {
      ok: true,
      mode: "live",
      summary: summarizePayResult(opts.url, parsed),
      raw: parsed,
      url: opts.url,
    };
  } catch (err) {
    log.warn("circle services pay failed", { url: opts.url, err: String(err) });
    return {
      ok: false,
      mode: "live",
      summary: `Pay failed: ${String(err)}`,
      url: opts.url,
    };
  }
}

function summarizePayResult(url: string, parsed: unknown): string {
  try {
    const s = JSON.stringify(parsed);
    if (s.length < 240) return s;
    const m = s.match(/"usd"\s*:\s*([0-9.]+)/i);
    if (m) return `Paid ${url}, usd≈${m[1]}`;
    const callId = s.match(/"call_id"\s*:\s*"([^"]+)"/i);
    if (callId) return `Outbound call queued (${callId[1]})`;
    return `Paid ${url}, got ${s.length} bytes`;
  } catch {
    return `Paid ${url}`;
  }
}

/** Resolve alias → URL (supports {symbol} path tokens). */
export function resolveAlias(
  alias: MarketplaceAlias,
  params?: Record<string, string>,
): { url: string; method: "GET" | "POST" | "PUT"; description: string } {
  const entry = MARKETPLACE_ALIASES[alias];
  let url: string = entry.url;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url = url.replace(`{${k}}`, encodeURIComponent(v));
    }
  }
  return { url, method: entry.method, description: entry.description };
}

/** Allowlist check for proxy — only known hosts or explicit X402_PROXY_ALLOW. */
export function proxyUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    const allow = (process.env.X402_PROXY_ALLOW ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const defaults = [
      "api.aisa.one",
      "nano.blockrun.ai",
      "stablephone.dev",
      "agents.allium.so",
      "api.coingecko.com",
      "np.orthogonal.com",
      "stableenrich.dev",
      "shop.circle.com",
    ];
    const host = u.hostname.toLowerCase();
    return [...defaults, ...allow].some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export type { MarketplaceResult as MarketplacePayResult };
