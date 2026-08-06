/**
 * Agent shopping — Circle Shop (UCP/Shopify) + marketplace Google Shopping search.
 *
 * Full buyer-approved checkout across millions of stores: https://shop.app/SKILL.md
 * Circle merch store: https://shop.circle.com/agents.md (UCP MCP + human approval)
 *
 * We never auto-complete card/Shop Pay. Search + cart/checkout *link* → human confirms.
 */
import { payMarketplaceUrl } from "./marketplaceCatalog.js";
import { log } from "./log.js";

const SHOP_BASE = process.env.SHOP_STORE_URL ?? "https://shop.circle.com";
const SHOP_UCP = process.env.SHOP_UCP_URL ?? `${SHOP_BASE}/.well-known/ucp`;
const SHOP_SKILL = "https://shop.app/SKILL.md";

export type ShopProduct = {
  id: string;
  title: string;
  handle: string;
  price: string;
  currency: string;
  url: string;
  image?: string;
  variantId?: string;
  vendor?: string;
  source: "circle_shop" | "google_shopping" | "mock";
};

export type ShopSearchResult = {
  ok: boolean;
  summary: string;
  products: ShopProduct[];
  skillHint: string;
  ucp?: unknown;
};

/** Read UCP merchant profile (no auth). */
export async function discoverShopUcp(): Promise<unknown> {
  try {
    const res = await fetch(SHOP_UCP);
    if (!res.ok) return { error: `UCP HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: String(e) };
  }
}

/** Search Circle shop catalog (public Shopify JSON — no payment). */
export async function searchCircleShop(query: string, limit = 5): Promise<ShopProduct[]> {
  const q = query.trim();
  if (!q) return [];

  try {
    const suggest = await fetch(
      `${SHOP_BASE}/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=${limit}`,
    );
    if (suggest.ok) {
      const data = (await suggest.json()) as {
        resources?: { results?: { products?: Record<string, unknown>[] } };
      };
      const rows = data.resources?.results?.products ?? [];
      if (rows.length) {
        return rows.slice(0, limit).map((p) => {
          const handle = String(p.handle ?? "");
          return {
            id: String(p.id ?? handle),
            title: String(p.title ?? "Product"),
            handle,
            price: String(p.price ?? p.price_min ?? "?"),
            currency: "USD",
            url: `${SHOP_BASE}/products/${handle}`,
            image: typeof p.image === "string" ? p.image : undefined,
            vendor: String(p.vendor ?? "Shop Circle"),
            source: "circle_shop" as const,
          };
        });
      }
    }
  } catch (e) {
    log.warn("circle shop suggest failed", { err: String(e) });
  }

  // Fallback: full product dump filter
  try {
    const res = await fetch(`${SHOP_BASE}/products.json?limit=50`);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      products?: {
        id: number;
        title: string;
        handle: string;
        vendor?: string;
        images?: { src?: string }[];
        variants?: { id: number; price: string }[];
      }[];
    };
    const needle = q.toLowerCase();
    return (data.products ?? [])
      .filter(
        (p) =>
          p.title.toLowerCase().includes(needle) ||
          p.handle.toLowerCase().includes(needle) ||
          (p.vendor ?? "").toLowerCase().includes(needle),
      )
      .slice(0, limit)
      .map((p) => ({
        id: String(p.id),
        title: p.title,
        handle: p.handle,
        price: p.variants?.[0]?.price ?? "?",
        currency: "USD",
        url: `${SHOP_BASE}/products/${p.handle}`,
        image: p.images?.[0]?.src,
        variantId: p.variants?.[0] ? String(p.variants[0].id) : undefined,
        vendor: p.vendor,
        source: "circle_shop" as const,
      }));
  } catch {
    return [];
  }
}

/** Enrich a Circle product with variant id for cart URL. */
export async function enrichCircleProduct(handle: string): Promise<ShopProduct | null> {
  try {
    const res = await fetch(`${SHOP_BASE}/products/${encodeURIComponent(handle)}.json`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      product?: {
        id: number;
        title: string;
        handle: string;
        vendor?: string;
        images?: { src?: string }[];
        variants?: { id: number; price: string }[];
      };
    };
    const p = data.product;
    if (!p) return null;
    return {
      id: String(p.id),
      title: p.title,
      handle: p.handle,
      price: p.variants?.[0]?.price ?? "?",
      currency: "USD",
      url: `${SHOP_BASE}/products/${p.handle}`,
      image: p.images?.[0]?.src,
      variantId: p.variants?.[0] ? String(p.variants[0].id) : undefined,
      vendor: p.vendor,
      source: "circle_shop",
    };
  } catch {
    return null;
  }
}

/** Google Shopping via StableEnrich (x402 when MARKETPLACE_LIVE). */
export async function searchGoogleShopping(
  query: string,
  phone: string,
  limit = 5,
): Promise<ShopProduct[]> {
  const url = `https://stableenrich.dev/api/serper/shopping?q=${encodeURIComponent(query)}&num=${limit}`;
  const paid = await payMarketplaceUrl({
    url,
    phone,
    method: "GET",
    kind: "nanopay:shop",
    maxAmount: process.env.X402_MAX_SHOP ?? "0.05",
  });
  if (!paid.ok || !paid.raw) return [];

  try {
    const raw = paid.raw as { shopping?: Record<string, unknown>[] } | Record<string, unknown>[];
    const rows = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { shopping?: unknown }).shopping)
        ? ((raw as { shopping: Record<string, unknown>[] }).shopping)
        : [];
    return rows.slice(0, limit).map((p, i) => ({
      id: String(p.productId ?? p.link ?? i),
      title: String(p.title ?? "Item"),
      handle: "",
      price: String(p.price ?? p.extracted_price ?? "?"),
      currency: String(p.currency ?? "USD"),
      url: String(p.link ?? p.source ?? ""),
      image: typeof p.imageUrl === "string" ? p.imageUrl : undefined,
      vendor: String(p.source ?? p.seller ?? "web"),
      source: "google_shopping" as const,
    }));
  } catch {
    return [];
  }
}

export async function shopSearch(opts: {
  query: string;
  phone?: string;
  limit?: number;
  web?: boolean;
}): Promise<ShopSearchResult> {
  const limit = opts.limit ?? 5;
  const circle = await searchCircleShop(opts.query, limit);
  let web: ShopProduct[] = [];
  if (opts.web && opts.phone) {
    web = await searchGoogleShopping(opts.query, opts.phone, limit);
  }

  const products = [...circle, ...web].slice(0, limit);
  if (!products.length) {
    return {
      ok: false,
      summary: `No products for "${opts.query}". Try another query, or use Shop skill ${SHOP_SKILL}`,
      products: [],
      skillHint: SHOP_SKILL,
    };
  }

  const lines = products.map(
    (p, i) => `${i + 1}. ${p.title} — $${p.price} (${p.vendor ?? p.source}) ${p.url}`,
  );
  return {
    ok: true,
    summary: `Found ${products.length}: ${lines.join(" · ")}. Checkout needs your approval — reply BUY ${products[0]!.handle || 1} to open a cart link. Full Shop skill: ${SHOP_SKILL}`,
    products,
    skillHint: SHOP_SKILL,
    ucp: await discoverShopUcp().catch(() => undefined),
  };
}

/** Shopify cart permalink — human opens and pays. */
export function cartCheckoutUrl(product: ShopProduct, qty = 1): string | null {
  if (product.source === "circle_shop" && product.variantId) {
    return `${SHOP_BASE}/cart/${product.variantId}:${qty}`;
  }
  if (product.url) return product.url;
  return null;
}

export function shopSkillUrl(): string {
  return SHOP_SKILL;
}

export function shopStoreUrl(): string {
  return SHOP_BASE;
}
