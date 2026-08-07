# Handover — hotline.guru

**Audience:** next engineer / ops / demo owner  
**Repo:** https://github.com/undefinedlab/hotline.guru  
**Branch at write-up:** `main` (`eef5740` + later)  
**Date:** 2026-08-06  
**Environment proven:** lab (HTTP + unit tests + softphone stack) **and the deployment shape** — Docker pack, Postgres driver, `HOTLINE_PROFILE=staging`, Circle DCW on Arc testnet. Live inbound DID is the remaining gap; Arc has no public mainnet.

Related: [CLEAR_DEMO_DID.md](./CLEAR_DEMO_DID.md) · [FUNCTIONALITY_AUDIT.md](./FUNCTIONALITY_AUDIT.md) · [SYSTEM_REVIEW.md](./SYSTEM_REVIEW.md) · [DEMO.md](../DEMO.md) · [README.md](../README.md)

---

## 1. What this product is

Call or text an agent. The phone number **is** the account. Spends **USDC on Arc** under a deterministic policy gate.

| Layer | Role |
|-------|------|
| Telephony / SMS / chat | UI |
| Policy + PIN | Leash |
| Circle DCW or local Arc EOAs | Money |
| x402 marketplace / shop | Agent spend surface |

**Safe investor claim:** Settlement path proven on **Arc testnet** under Circle developer-controlled custody. Arc has no public mainnet yet — testnet is the only network.  
**Do not claim:** live mainnet USDC, telco-native SIM-swap, corridor cash-in/out, unattended production standing-order workers.

---

## 2. Feature inventory (what we have)

Legend: **WORKS** lab-ready · **PARTIAL** code/stub · **BLOCKED** needs ops/creds · **MISSING** not built

### Money & custody

| Feature | Status | Notes |
|---------|--------|-------|
| Onboard (name + PIN → wallet on MSISDN) | WORKS | Pipeline + AGI + lab HTTP |
| Send to known payee | WORKS | PIN confirm; `WALLET_MODE=local` or Circle |
| Pending-claim escrow (unknown MSISDN) | WORKS | Hold, fulfill on onboard, expiry refund on the worker timer |
| Hard ceiling refuse (no PIN dance) | WORKS | Policy gate |
| Circle DCW (no silent local fallback) | WORKS | Explicit `WALLET_MODE=local` or `ALLOW_LOCAL_FALLBACK=1` |
| Async settle ack (`ASYNC_SETTLE=1`) | PARTIAL | Voice-friendly; thin automated coverage |
| Hash-chained `policy_audit` | WORKS | Export token outside open lab |
| Mainnet USDC | N/A | Arc has no public mainnet — out of scope |
| Cash-in / cash-out corridor | MISSING | Docs-only |

### Policy & identity

| Feature | Status | Notes |
|---------|--------|-------|
| Spoken policy compile + freeze | WORKS | e.g. new-payee cap |
| PIN lockout | WORKS | After `PIN_MAX_FAILS` |
| CHANGE PIN | WORKS | Intent path |
| RECOVER PIN | PARTIAL | Code path; **outbound call stub** |
| REPORT SIM cool-down | PARTIAL | Manual; **no telco feed** |
| CALLBACK verify | PARTIAL | Lab stub; **no real trunk dial** |
| HotlineNS (`CLAIM` / whois) | WORKS | Off-chain by design |
| VERIFY ID / identity tiers | WORKS | Cap bump |
| SIM ATTEST | PARTIAL | Mock default; live needs marketplace fraud pay |

### Voice & channels

| Feature | Status | Notes |
|---------|--------|-------|
| FastAGI softphone (onboard / send / PIN) | WORKS | `hotline` / `hotline-lab` @ Asterisk |
| Flash / missed-call balance | WORKS | Dial `flash`; live SMS for real text |
| Dial-a-rate | WORKS | Dial `rate` |
| Voice memo on send | WORKS | Payee SMS needs live SMS |
| SMS / WhatsApp / Telegram ingress | PARTIAL | **Mock** default; live tokens/webhooks |
| Live inbound DID (PSTN) | BLOCKED | Telnyx US DID + public SIP recommended |

### Retention, shop, x402

| Feature | Status | Notes |
|---------|--------|-------|
| Standing orders create / list / cancel | WORKS | Run by the in-process worker; `npm run standing` for one-shot |
| Savings lock | PARTIAL | Works in code; thin E2E tests |
| Shop search (Circle merch) | WORKS | Public Shopify JSON |
| Buy → cart link (human pays) | WORKS | Never auto-checkout |
| x402 `discover` / `shop` / `buy` / `ask` / `verify` | WORKS | Lab: `X-Payment: lab` |
| x402 `price` / `deliver` / `call` / `research` / `fraud` / `proxy` | PARTIAL | Live needs Gateway / funded ops |
| Google Shopping / Amazon scrape | BLOCKED | `MARKETPLACE_LIVE=1` + Gateway |

### Frontend / ops

| Feature | Status | Notes |
|---------|--------|-------|
| Marketing site (`hotline_front`) | WORKS | Not operator UI |
| Operator dashboard | MISSING | Lab HTTP / CLI only |
| Docker pack + staging profile gates | WORKS | `HOTLINE_PROFILE=staging` refuses weak config |
| CI (typecheck, tests, audit, docker build) | WORKS | `.github/workflows/ci.yml` |

---

## 3. Automated test results

**Captured:** 2026-08-06 · machine: local Windows · Node via `npm test` / `npm run typecheck`

| Check | Result | Detail |
|-------|--------|--------|
| `npm test` | **PASS** | **52** tests, **16** suites, **0** fail, ~5.1s |
| `npm run typecheck` | **PASS** | `tsc -p orchestrator/tsconfig.json --noEmit` |

### Suite breakdown (all pass)

| Suite | File | Cases |
|-------|------|-------|
| HotlineNS | `identity.test.ts` | label validate; claim + resolve |
| identity tiers | `identity.test.ts` | intent parse; ID + SIM attest cap raise |
| channel identity | `ingress.test.ts` | WA → E.164; Telegram `tg:` |
| webhook parsers | `ingress.test.ts` | Meta WA; Telegram; WA verify challenge |
| ingress replies | `ingress.test.ts` | WA mock + TG mock after pipeline |
| parseIntent (policy file) | `policy.test.ts` | join / send / price / confirm |
| policy | `policy.test.ts` | hard reject; soft confirm; price nanopay |
| parseIntent (intent file) | `intent.test.ts` | demo sentence; pin/confirm; hello/name |
| rateLimit | `ops.test.ts` | allow/block; ingress helper |
| webhooks | `ops.test.ts` | Telnyx reject/HMAC/ed25519; AT; generic SMS HMAC |
| profile | `ops.test.ts` | lab default; staging refuse; channelStatus no secrets |
| pipeline | `pipeline.test.ts` | onboard + greet; block until named + ceiling |
| pipeline full | `pipeline.test.ts` | welcome→PIN; pending claim; ceiling; PIN lock; spoken policy freeze |
| spoken policy compile | `policyRules.test.ts` | demo sentence; POLICY; standing; lock; dial-a-rate; shop/buy |
| normalizeTranscript | `stt.test.ts` | hus+digits; split digits after `to` |
| x402 agent marketplace | `x402.test.ts` | caps; aliases; proxy allowlist; **network** discover/shop/buy |

### Not covered by unit tests (manual / ops)

- AGI / Asterisk integration (softphone E2E)
- Live Circle transfer confirmation on ArcScan
- Claim expiry worker / standing cron
- CHANGE / RECOVER PIN end-to-end with real outbound
- CALLBACK / REPORT SIM with live trunks
- Live SMS / WhatsApp / Telegram providers
- PSTN inbound DID
- Frontend visual QA

Re-run anytime:

```bash
npm test
npm run typecheck
```

---

## 4. How to run (lab handover)

```bash
cp .env.example .env
# Lab money without Circle: WALLET_MODE=local
npm install
npm test
npm run start                    # HTTP :8787 + FastAGI :4573
# optional voice pack:
npm run telephony                # Asterisk + STT
# softphone: user hotline / pass hotline-lab → dial hotline | flash | rate
```

Lab HTTP:

```bash
curl -X POST localhost:8787/v1/message \
  -H 'content-type: application/json' \
  -d '{"phone":"+15550001","text":"BALANCE"}'
```

Funded demo path: `npm run funds` then `npm run demo` (see [DEMO.md](../DEMO.md)).

Circle path: set `CIRCLE_*` → `npm run circle:register-secret` → `CIRCLE_WALLET_SET_ID` → `npm run circle:smoke`.

---

## 5. Demo script (what to show)

1. Onboard → name → PIN → greet on recall  
2. `send …` under ceiling → PIN → settle / pending claim  
3. Over ceiling → **hard refuse** (no PIN)  
4. Wrong PIN × N → **lockout**  
5. Spoken policy → freeze → refuse over new-payee cap  
6. Softphone: `flash`, `rate`, optional voice memo  
7. `POST /v1/x402/discover` + `/shop` + `/buy` (`X-Payment: lab`)  

**Live phone from DE/IN:** buy **US local** DID (Telnyx preferred; docs not required for US), SIP → Asterisk public IP. Avoid DE DID KYC and US toll-free for international callers.

---

## 6. Known stubs & honesty gaps

| Item | Reality |
|------|---------|
| RECOVER / CALLBACK outbound | Stub — no real originate |
| Standing / claim expiry | CLI / code only — schedule yourself |
| SMS/WA/TG | Mock unless provider env set |
| `.env.example` vs code | Code refuses silent Circle→local fallback |
| README “creates wallet if new” | Prefer **pending claim** language for unknown payees |

Full status matrix: [FUNCTIONALITY_AUDIT.md](./FUNCTIONALITY_AUDIT.md).

---

## 7. Suggested next work (priority)

1. ~~Cron sidecar~~ — done: in-process workers (`WORKERS_INTERVAL_MIN`)  
2. One funded Circle **testnet** transfer with ArcScan link in console  
3. Replace CALLBACK / recovery stubs (AMI or Telnyx originate)  
4. Wire Telnyx/Zadarma US DID → `SIP_*` + `PUBLIC_IP` in `.env` → `npm run trunk` for PSTN demo  
5. Corridor cash-in/out only after 1–4  

---

## 8. Handover checklist

- [ ] `npm install` · `npm test` (expect **52** pass) · `npm run typecheck`  
- [ ] Read [DEMO.md](../DEMO.md) and run `npm run demo` once with funded lab wallets  
- [ ] Softphone smoke: dial `hotline` onboard path  
- [ ] Confirm `.env`: `WALLET_MODE` intentional; no production secrets in git  
- [ ] Know which claim language is safe (testnet vs mainnet)  
- [ ] If live voice: public host + US DID + SIP ports 5060 / RTP 10000–10099  

---

## 9. Key paths

| Area | Path |
|------|------|
| HTTP + webhooks | `orchestrator/src/server.ts` |
| Voice AGI | `orchestrator/src/agi/server.ts` |
| Pipeline / intents | `orchestrator/src/lib/pipeline.ts`, `intent.ts` |
| Policy | `orchestrator/src/lib/policy.ts`, `policyRules.ts` |
| Claims / retention / shop / x402 | `claims.ts`, `retention.ts`, `shop.ts`, `x402.ts` |
| Asterisk | `telephony/asterisk/` |
| Marketing UI | `hotline_front/` |
