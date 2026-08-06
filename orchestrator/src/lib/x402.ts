/**
 * Hotline as an x402 endpoint — agent-to-human last mile (B2A)
 * plus agent→marketplace chaining (pay other x402 services).
 *
 * Capabilities:
 *   deliver | ask | verify | call | research | price | fraud | discover | proxy
 *
 * Lab: X-PAYMENT: lab  ·  Staging: X402_PAYMENT_SECRET HMAC
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizePhone } from "./db.js";
import { handleMessage } from "./pipeline.js";
import { createSmsProvider } from "./sms.js";
import { canReceiveSms } from "./channel.js";
import { log } from "./log.js";
import { hotlineProfile } from "./profile.js";
import {
  discoverMarketplace,
  fetchCryptoPrice,
  outboundMarketplaceCall,
  phoneFraudLookup,
  researchQuery,
} from "./marketplace.js";
import {
  MARKETPLACE_ALIASES,
  payMarketplaceUrl,
  proxyUrlAllowed,
  type MarketplaceAlias,
} from "./marketplaceCatalog.js";
import {
  cartCheckoutUrl,
  enrichCircleProduct,
  shopSearch,
  shopSkillUrl,
  shopStoreUrl,
} from "./shop.js";

const sms = createSmsProvider();

export type X402Capability =
  | "deliver"
  | "ask"
  | "verify"
  | "call"
  | "research"
  | "price"
  | "fraud"
  | "discover"
  | "proxy"
  | "shop"
  | "buy";

export type X402Resource = {
  capability: X402Capability;
  description: string;
  priceUsdc: number;
  marketplace?: string;
};

export const X402_RESOURCES: X402Resource[] = [
  {
    capability: "deliver",
    description: "Deliver USDC to a phone number (pending-claim escrow)",
    priceUsdc: Number(process.env.X402_PRICE_DELIVER ?? 0.01),
  },
  {
    capability: "ask",
    description: "Ask a human a question by SMS; they reply to the hotline",
    priceUsdc: Number(process.env.X402_PRICE_ASK ?? 0.01),
  },
  {
    capability: "verify",
    description: "Ask a human to verify something physical",
    priceUsdc: Number(process.env.X402_PRICE_VERIFY ?? 0.02),
  },
  {
    capability: "call",
    description: "Outbound AI phone call via StablePhone / BlockRun (marketplace x402)",
    priceUsdc: Number(process.env.X402_PRICE_CALL ?? 0.55),
    marketplace: MARKETPLACE_ALIASES.call.url,
  },
  {
    capability: "research",
    description: "Pay Perplexity Sonar via AIsa and return an answer",
    priceUsdc: Number(process.env.X402_PRICE_RESEARCH ?? 0.03),
    marketplace: MARKETPLACE_ALIASES.research.url,
  },
  {
    capability: "price",
    description: "Pay CoinGecko/AIsa for a crypto price quote",
    priceUsdc: Number(process.env.X402_PRICE_QUOTE ?? 0.01),
    marketplace: MARKETPLACE_ALIASES.price.url,
  },
  {
    capability: "fraud",
    description: "BlockRun phone fraud / SIM-swap signals",
    priceUsdc: Number(process.env.X402_PRICE_FRAUD ?? 0.05),
    marketplace: MARKETPLACE_ALIASES.fraud.url,
  },
  {
    capability: "discover",
    description: "Search Circle Agent Marketplace (discovery API, no spend)",
    priceUsdc: Number(process.env.X402_PRICE_DISCOVER ?? 0),
  },
  {
    capability: "proxy",
    description: "Pay an allowlisted marketplace URL on behalf of the agent",
    priceUsdc: Number(process.env.X402_PRICE_PROXY ?? 0.01),
  },
  {
    capability: "shop",
    description:
      "Search products (Circle shop + optional Google Shopping). Checkout always needs human approval — see shop.app/SKILL.md",
    priceUsdc: Number(process.env.X402_PRICE_SHOP ?? 0.01),
    marketplace: MARKETPLACE_ALIASES.shopping.url,
  },
  {
    capability: "buy",
    description:
      "Prepare a cart/checkout link for a Circle shop product (human must open & pay — never auto-complete)",
    priceUsdc: Number(process.env.X402_PRICE_BUY ?? 0.01),
  },
];

const CAP_SET = new Set(X402_RESOURCES.map((r) => r.capability));

export function isX402Capability(s: string): s is X402Capability {
  return CAP_SET.has(s as X402Capability);
}

export function paymentRequiredBody(capability: X402Capability) {
  const res = X402_RESOURCES.find((r) => r.capability === capability);
  return {
    x402Version: 1,
    error: "Payment Required",
    accepts: [
      {
        scheme: "exact",
        network: process.env.X402_NETWORK ?? "arc-testnet",
        maxAmountRequired: String(Math.round((res?.priceUsdc ?? 0.01) * 1e6)),
        asset: process.env.X402_ASSET ?? "USDC",
        payTo: process.env.X402_PAY_TO ?? process.env.OPERATOR_ARC_ADDRESS ?? "0xhotline",
        resource: `/v1/x402/${capability}`,
        description: res?.description ?? capability,
      },
    ],
    marketplace: res?.marketplace,
  };
}

function labPaymentOk(proof: string | undefined, header: string | undefined): boolean {
  if (process.env.X402_LAB_FREE === "1") return true;
  if (hotlineProfile() === "lab") {
    const p = (proof ?? header ?? "").toLowerCase();
    return p === "lab" || p === "demo" || p.startsWith("lab:");
  }
  return false;
}

function hmacPaymentOk(canonical: string, proof: string | undefined): boolean {
  const secret = process.env.X402_PAYMENT_SECRET;
  if (!secret || !proof) return false;
  const expect = createHmac("sha256", secret).update(canonical).digest("hex");
  try {
    const a = Buffer.from(expect);
    const b = Buffer.from(proof.replace(/^sha256=/i, ""));
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function verifyX402Payment(opts: {
  capability: string;
  body: unknown;
  paymentHeader?: string;
  paymentProof?: string;
}): { ok: true; mode: string } | { ok: false; reason: string } {
  // discover can be free
  if (opts.capability === "discover" && Number(process.env.X402_PRICE_DISCOVER ?? 0) === 0) {
    return { ok: true, mode: "free" };
  }
  if (labPaymentOk(opts.paymentProof, opts.paymentHeader)) {
    return { ok: true, mode: "lab" };
  }
  const canonical = JSON.stringify({
    capability: opts.capability,
    body: opts.body,
  });
  if (hmacPaymentOk(canonical, opts.paymentProof ?? opts.paymentHeader)) {
    return { ok: true, mode: "hmac" };
  }
  return { ok: false, reason: "payment required" };
}

export type X402FulfillInput = {
  capability: X402Capability;
  to?: string;
  amount?: number;
  question?: string;
  memo?: string;
  symbol?: string;
  query?: string;
  task?: string;
  url?: string;
  method?: "GET" | "POST" | "PUT";
  data?: unknown;
  provider?: "stablephone" | "bland";
  alias?: MarketplaceAlias;
  web?: boolean;
  handle?: string;
  qty?: number;
};

export async function fulfillX402(
  opts: X402FulfillInput,
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown> }> {
  const ops = process.env.X402_OPS_ACCOUNT ?? process.env.ESCROW_ACCOUNT ?? "+10000000000";

  if (opts.capability === "discover") {
    const hit = await discoverMarketplace({
      query: opts.query ?? opts.question ?? "phone",
      limit: 12,
    });
    return {
      ok: hit.ok,
      summary: hit.summary,
      data: { mode: hit.mode, raw: hit.raw, aliases: Object.keys(MARKETPLACE_ALIASES) },
    };
  }

  if (opts.capability === "price") {
    const sym = opts.symbol ?? "bitcoin";
    const price = await fetchCryptoPrice(sym, ops);
    return {
      ok: price.ok,
      summary: price.summary,
      data: { mode: price.mode, symbol: sym, raw: price.raw },
    };
  }

  if (opts.capability === "research") {
    const q = opts.question ?? opts.query ?? opts.memo;
    if (!q) return { ok: false, summary: "research requires question" };
    const hit = await researchQuery(q, ops);
    return {
      ok: hit.ok,
      summary: hit.summary,
      data: { mode: hit.mode, url: hit.url, raw: hit.raw },
    };
  }

  if (opts.capability === "fraud") {
    if (!opts.to) return { ok: false, summary: "fraud requires to (MSISDN)" };
    const hit = await phoneFraudLookup(normalizePhone(opts.to));
    return {
      ok: hit.ok,
      summary: hit.summary,
      data: { mode: hit.mode, to: normalizePhone(opts.to), raw: hit.raw },
    };
  }

  if (opts.capability === "call") {
    if (!opts.to) return { ok: false, summary: "call requires to (MSISDN)" };
    const task =
      opts.task ??
      opts.question ??
      opts.memo ??
      "Introduce yourself as hotline.guru and ask if they can confirm receipt.";
    const hit = await outboundMarketplaceCall({
      to: normalizePhone(opts.to),
      task,
      phone: ops,
      provider: opts.provider,
    });
    // Lab fallback: SMS the task if marketplace pay is off
    if (!hit.ok && hit.mode === "mock") {
      const to = normalizePhone(opts.to);
      if (canReceiveSms(to)) {
        void sms.send(to, `hotline.guru call (lab): ${task}`).catch(() => {});
      }
      return {
        ok: true,
        summary: `Lab stub: would pay StablePhone/BlockRun for outbound call to ${to}. SMS'd task instead. Enable MARKETPLACE_LIVE=1 for real AI call.`,
        data: { lab: true, to, task },
      };
    }
    return {
      ok: hit.ok,
      summary: hit.summary,
      data: { mode: hit.mode, url: hit.url, raw: hit.raw },
    };
  }

  if (opts.capability === "proxy") {
    const url = opts.url;
    if (!url) return { ok: false, summary: "proxy requires url" };
    if (!proxyUrlAllowed(url)) {
      return {
        ok: false,
        summary: `URL host not allowlisted. Use discover + aliases, or set X402_PROXY_ALLOW.`,
      };
    }
    const hit = await payMarketplaceUrl({
      url,
      phone: ops,
      method: opts.method ?? "GET",
      data: opts.data,
      kind: "nanopay:proxy",
      maxAmount: process.env.X402_MAX_PROXY ?? "0.50",
    });
    if (!hit.ok && hit.mode === "mock") {
      return {
        ok: true,
        summary: `Lab stub: would pay ${url}. Set MARKETPLACE_LIVE=1 to execute.`,
        data: { lab: true, url },
      };
    }
    return {
      ok: hit.ok,
      summary: hit.summary,
      data: { mode: hit.mode, url, raw: hit.raw },
    };
  }

  if (opts.capability === "shop") {
    const q = opts.query ?? opts.question ?? opts.memo;
    if (!q) return { ok: false, summary: "shop requires query" };
    const hit = await shopSearch({
      query: q,
      phone: ops,
      limit: 5,
      web: Boolean(opts.web),
    });
    return {
      ok: hit.ok,
      summary: hit.summary,
      data: {
        products: hit.products,
        skill: hit.skillHint,
        store: shopStoreUrl(),
        agentsMd: `${shopStoreUrl()}/agents.md`,
      },
    };
  }

  if (opts.capability === "buy") {
    const handle = opts.handle ?? opts.query ?? opts.memo;
    if (!handle) {
      return {
        ok: false,
        summary: `buy requires handle (e.g. unisex-tee). Search first via shop. Skill: ${shopSkillUrl()}`,
      };
    }
    const product = await enrichCircleProduct(handle.replace(/^\/products\//, ""));
    if (!product) {
      return {
        ok: false,
        summary: `Product "${handle}" not found on ${shopStoreUrl()}. Try shop capability first.`,
      };
    }
    const qty = opts.qty && opts.qty > 0 ? opts.qty : 1;
    const checkout = cartCheckoutUrl(product, qty);
    // SMS human if `to` provided — buyer must open link
    if (opts.to && checkout && canReceiveSms(normalizePhone(opts.to))) {
      void sms
        .send(
          normalizePhone(opts.to),
          `hotline.guru cart: ${product.title} $${product.price} ×${qty}. Open to pay (you approve): ${checkout}`,
        )
        .catch(() => {});
    }
    return {
      ok: true,
      summary: `Cart ready for ${product.title} ($${product.price}). Human must open and pay — agents never auto-complete. ${checkout ?? product.url}. Full multi-store buy: ${shopSkillUrl()}`,
      data: {
        product,
        checkoutUrl: checkout,
        skill: shopSkillUrl(),
        requiresHumanApproval: true,
      },
    };
  }

  if (opts.capability === "deliver") {
    if (!opts.to) return { ok: false, summary: "deliver requires to" };
    const amount = opts.amount ?? 0;
    if (!(amount > 0)) {
      return { ok: false, summary: "deliver requires amount > 0" };
    }
    const to = normalizePhone(opts.to);
    const text = `send ${amount} usdt to ${to}`;
    const result = await handleMessage(ops, text);
    if (result.needsPin) {
      const pin = process.env.DEMO_PIN ?? "1234";
      const done = await handleMessage(ops, `CONFIRM ${pin}`);
      return {
        ok: !done.needsPin,
        summary: done.reply,
        data: done.data,
      };
    }
    return { ok: true, summary: result.reply, data: result.data };
  }

  if (opts.capability === "ask" || opts.capability === "verify") {
    if (!opts.to) return { ok: false, summary: `${opts.capability} requires to` };
    const to = normalizePhone(opts.to);
    const q =
      opts.question ??
      (opts.capability === "verify"
        ? "Please verify the physical item and reply YES or NO."
        : "An agent has a question for you.");
    const body =
      opts.capability === "verify"
        ? `hotline.guru verify: ${q}`
        : `hotline.guru ask: ${q}${opts.memo ? ` (${opts.memo})` : ""}`;
    log.info("x402 human reach", { capability: opts.capability, to });
    if (canReceiveSms(to)) {
      void sms.send(to, body).catch(() => {});
    }
    return {
      ok: true,
      summary: `Queued ${opts.capability} to ${to}. Human replies by SMS to the hotline.`,
      data: { to, capability: opts.capability, queued: true },
    };
  }

  return { ok: false, summary: "unknown capability" };
}

export function marketplaceAliasesForAgents() {
  return Object.entries(MARKETPLACE_ALIASES).map(([alias, v]) => ({
    alias,
    url: v.url,
    method: v.method,
    description: v.description,
    category: v.category,
  }));
}
