import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MARKETPLACE_ALIASES, proxyUrlAllowed } from "./marketplaceCatalog.js";
import { isX402Capability, X402_RESOURCES, fulfillX402 } from "./x402.js";

describe("x402 agent marketplace", () => {
  it("exposes human + marketplace capabilities", () => {
    const caps = X402_RESOURCES.map((r) => r.capability);
    for (const c of [
      "deliver",
      "ask",
      "verify",
      "call",
      "research",
      "price",
      "fraud",
      "discover",
      "proxy",
      "shop",
      "buy",
    ]) {
      assert.ok(caps.includes(c as never), c);
      assert.equal(isX402Capability(c), true);
    }
  });

  it("curates StablePhone / BlockRun / AIsa aliases", () => {
    assert.match(MARKETPLACE_ALIASES.call.url, /stablephone/);
    assert.match(MARKETPLACE_ALIASES.fraud.url, /blockrun/);
    assert.match(MARKETPLACE_ALIASES.price.url, /aisa|coingecko/i);
    assert.match(MARKETPLACE_ALIASES.research.url, /perplexity|sonar/i);
    assert.match(MARKETPLACE_ALIASES.shopping.url, /stableenrich|shopping/i);
  });

  it("allowlists marketplace hosts for proxy", () => {
    assert.equal(proxyUrlAllowed("https://stablephone.dev/api/call"), true);
    assert.equal(proxyUrlAllowed("https://evil.example/pay"), false);
  });

  it("discover returns marketplace hits (network)", async () => {
    const r = await fulfillX402({ capability: "discover", query: "stablephone" });
    assert.equal(r.ok, true);
    assert.match(r.summary, /Found|service/i);
  });

  it("shop searches Circle storefront", async () => {
    const r = await fulfillX402({ capability: "shop", query: "tee" });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.data?.products));
    assert.ok((r.data!.products as unknown[]).length >= 1);
  });

  it("buy prepares cart link with human approval flag", async () => {
    const r = await fulfillX402({ capability: "buy", handle: "unisex-tee" });
    assert.equal(r.ok, true);
    assert.equal(r.data?.requiresHumanApproval, true);
    assert.match(String(r.data?.checkoutUrl ?? ""), /cart|products/);
  });
});
