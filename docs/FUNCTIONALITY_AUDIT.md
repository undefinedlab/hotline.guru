# Functionality audit — hotline.guru

**Date:** 2026-08-06  
**Scope:** Code + unit tests (`52` pass, `0` fail) vs investor/demo claims.  
**Handover:** See [HANDOVER.md](./HANDOVER.md) for full feature inventory + test suite breakdown.  
**Verdict:** Strong **lab / Arc testnet** product spine. Several “shipped” items are stubs or need ops. Cash-in/out is not built; mainnet does not exist on Arc yet.

Legend:

| Status | Meaning |
|--------|---------|
| **WORKS** | Runnable in lab with clear path; covered by tests or smoke |
| **PARTIAL** | Code exists; stub, mock default, or missing worker/UX |
| **BLOCKED** | Needs external credentials / funded wallets / live trunks |
| **MISSING** | Not implemented (docs-only) |

---

## Executive summary

| Bucket | Count (approx) |
|--------|----------------|
| WORKS in lab | ~12 |
| PARTIAL | ~10 |
| BLOCKED on ops | ~5 |
| MISSING | ~3 |

**Safe claim:** Settlement path proven on Arc **testnet** — Arc has no public mainnet yet, so testnet is the only network.  
**Unsafe claim:** Live mainnet USDC · cash-in/out · telco-native identity.

---

## Core money path

| Feature | Status | Evidence | What you need |
|---------|--------|----------|---------------|
| Onboard (name + PIN) | **WORKS** | `pipeline.ts`, `pipeline.test.ts`, AGI | Lab HTTP / softphone / SMS |
| Hard ceiling refuse | **WORKS** | `policy.ts`, tests | Nothing special |
| Phone send → known payee | **WORKS** | `pipeline.ts`, `wallets.ts` | Funded sender (`WALLET_MODE=local` + fund, or Circle) |
| Pending-claim escrow (unknown MSISDN) | **WORKS** | `claims.ts`, `workers.ts`, tests | Hold, fulfill-on-onboard, and scheduled expiry refund |
| Circle DCW (no silent local fallback) | **WORKS** | `circle.ts` `resolveWalletMode` | `CIRCLE_*` or explicit `WALLET_MODE=local` / `ALLOW_LOCAL_FALLBACK=1` |
| Async settle ack | **PARTIAL** | `ASYNC_SETTLE` in `pipeline.ts` | Env flag; no dedicated test |
| Hash-chained `policy_audit` | **WORKS** | `db.ts` `recordPolicyDecision` | Export needs `AUDIT_EXPORT_TOKEN` outside open lab |
| Mainnet USDC | **N/A** | Arc testnet chain in config | Arc has no public mainnet — out of scope, not a gap |
| Cash-in / cash-out corridor swap | **MISSING** | Docs only | Partner + product build |

---

## Policy & identity

| Feature | Status | Evidence | What you need |
|---------|--------|----------|---------------|
| Spoken policy freeze | **WORKS** | `policyRules.ts`, pipeline test | Phrases the regex/LLM compiler understands |
| PIN lockout | **WORKS** | `pipeline.test.ts` | — |
| CHANGE PIN | **WORKS** | `pipeline.ts` | Intent `CHANGE PIN <old> <new>` |
| RECOVER PIN | **PARTIAL** | `pipeline.ts` | SMS code path; **outbound call is a stub** |
| REPORT SIM → cool-down | **PARTIAL** | `pipeline.ts`, `policy.ts` | Manual only — **no telco feed** |
| CALLBACK verify | **PARTIAL** | `pipeline.ts` | Lab stub sets window; **no real trunk dial** |
| HotlineNS claim / whois | **WORKS** | `hotlinens.ts`, tests | Off-chain by design |
| Identity VERIFY ID | **WORKS** | `identity.ts`, tests | Hashed ID → tier bump |
| SIM ATTEST | **PARTIAL** | `identity.ts` | Lab `SIM_ATTEST_MODE=mock`; live needs marketplace fraud pay |

---

## Voice & channels

| Feature | Status | Evidence | What you need |
|---------|--------|----------|---------------|
| FastAGI softphone (onboard / send / PIN) | **WORKS** | `agi/server.ts`, `telephony/` | `npm run telephony` + STT optional |
| Flash / missed-call balance | **WORKS** | AGI `flash`, `extensions.conf` | Live SMS for real text; else mock log |
| Dial-a-rate | **WORKS** | `handleDialRate`, AGI `rate` | Public CoinGecko if marketplace off |
| Voice memo on send | **WORKS** | `attachSendMemo`, AGI | Voice path; payee SMS needs live SMS |
| SMS ingress | **PARTIAL** | `sms.ts`, webhooks | Default **mock**; Telnyx/AT for live |
| WhatsApp / Telegram | **PARTIAL** | `whatsapp.ts`, `telegram.ts`, tests | Mock works; live tokens required |
| Live inbound DID | **BLOCKED** | Trunk config examples | Telnyx/AT production |

---

## Retention & shop

| Feature | Status | Evidence | What you need |
|---------|--------|----------|---------------|
| Standing order create / list / cancel | **WORKS** | `retention.ts`, `workers.ts` | Executed on the worker timer; `npm run standing` still runs it once |
| Savings lock | **PARTIAL** | `retention.ts`, policy gate | Works in code; thin test coverage; unlock on read |
| Shop search (Circle merch) | **WORKS** | `shop.ts`, `x402.test.ts` | Public Shopify JSON |
| Buy → cart link (human pays) | **WORKS** | `shop.ts`, x402 `buy` | Never auto-completes (correct) |
| Google Shopping / Amazon scrape | **BLOCKED** | aliases in `marketplaceCatalog.ts` | `MARKETPLACE_LIVE=1` + Gateway |

---

## Agent x402 surface (`GET/POST /v1/x402`)

| Capability | Status | Lab without `MARKETPLACE_LIVE` | Live pay |
|------------|--------|--------------------------------|----------|
| `discover` | **WORKS** | Circle Discovery API | — |
| `shop` / `buy` | **WORKS** | Circle storefront | optional web shop |
| `price` | **PARTIAL** | Public CoinGecko fallback | AIsa via `circle services pay` |
| `deliver` | **PARTIAL** | Needs funded ops + PIN | Same |
| `ask` / `verify` | **WORKS** | SMS mock/live queue | — |
| `call` | **PARTIAL** | Lab SMS stub | StablePhone / Bland x402 |
| `research` | **PARTIAL** | Fails closed / message | AIsa Sonar |
| `fraud` | **PARTIAL** | Mock skip | BlockRun on MATIC Gateway |
| `proxy` | **PARTIAL** | Lab stub | Allowlisted hosts only |

Lab payment: `X-Payment: lab` (or `X402_LAB_FREE=1`).

---

## Frontend

| Feature | Status | Notes |
|---------|--------|-------|
| Marketing site (`hotline_front`) | **WORKS** | Modules + Features section; not the product UI |
| Product dashboard / console | **MISSING** | No operator UI beyond lab HTTP |

---

## Test & CI signal

- `npm run typecheck` — pass  
- `npm test` — **52** pass (intent, policy, pipeline, identity, ingress, ops, policyRules, x402)  
- **Not covered by tests:** standing execution, savings lock E2E, claim expiry, async settle, CHANGE/RECOVER PIN, CALLBACK, live Circle transfer, AGI integration  

---

## Doc honesty gaps (fix when pitching)

1. `.env.example` still says Circle **soft-falls** to local — **code refuses silent fallback**.  
2. SYSTEM_REVIEW “shipped” list lumps stubs (recovery callback, standing cron, claim expiry) with proven lab paths.  
3. Demo scripts may still imply “provisions payee wallet” — behavior is **pending claim**.  

---

## What to demo tomorrow (lab)

1. Softphone / `POST /v1/message` — onboard → PIN → send → refuse ceiling  
2. Spoken policy → freeze → over new-payee refuse  
3. Flash / dial-a-rate  
4. `POST /v1/x402/shop` + `/buy` cart link  
5. `POST /v1/x402/discover`  

## What not to claim

- Live mainnet settlement  
- Telco SIM-swap detection  
- Real outbound callback identity  
- Corridor cash-in/out  
- Unattended standing-order production worker  

---

## Suggested next engineering (priority)

1. ~~Wire claim expiry + standing to a cron sidecar~~ — done in `workers.ts`  
2. One **funded Circle testnet** transfer proof in your console  
3. Replace CALLBACK / recovery stubs with AMI/Telnyx originate  
4. Fix `.env.example` soft-fallback wording  
5. Corridor escrow (business unlock) — after 1–3  

Related: [SYSTEM_REVIEW.md](./SYSTEM_REVIEW.md) · [DEMO.md](../DEMO.md) · [PITCH_DECK.md](./PITCH_DECK.md)
