# hotline.guru — System review

**As of:** 2026-08-05  
**Branch tip:** `6417475` (undefinedlab)  
**One-liner:** Call or text an agent; it spends **USDC on Arc** under a deterministic policy gate. Phone number = account. LLM proposes; code disposes.

This document describes what is built today, how the pieces connect, and what is still open.

---

## 1. Product thesis

| Principle | Meaning in code |
|-----------|-----------------|
| Telephony = UI | Voice (Asterisk + FastAGI), SMS, WhatsApp, Telegram — no wallet app required |
| Policy = leash | Soft / daily / hard caps by identity tier; refusal is a feature |
| Circle / Arc = money | Default custody is Circle DCW on **Arc Testnet** (SCA + Gas Station). Arc has no public mainnet yet. |
| x402 = spend | Optional live marketplace pay; public price fallback otherwise |
| No own token | USDC only; spoken “USDT” maps to USDC on Arc |
| LLM never authorizes | Intent parsing may be smart later; `evaluatePolicy` + PIN gate money |

---

## 2. Architecture (end-to-end)

```text
┌─────────────┐  ┌──────────┐  ┌───────────┐  ┌────────────┐
│ Softphone / │  │ Telnyx / │  │ WhatsApp  │  │ Telegram   │
│ SIP trunk   │  │ AT SMS   │  │ Cloud API │  │ Bot API    │
└──────┬──────┘  └────┬─────┘  └─────┬─────┘  └─────┬──────┘
       │              │              │               │
       ▼              ▼              ▼               ▼
┌──────────────┐  ┌────────────────────────────────────────┐
│ Asterisk     │  │ HTTP orchestrator (:8787)              │
│ + STT        │──│  webhooks → ingress → pipeline         │
│ FastAGI      │  │  FastAGI (:4573, internal in compose) │
└──────────────┘  └──────────────────┬─────────────────────┘
                                     │
                     intent → policy → wallets / Circle
                                     │
                                     ▼
                          Arc Testnet USDC + ledger
```

**Core loop**

1. **Ingress** identifies an account (`+E.164`, `tg:<chatId>`, or WhatsApp → same E.164).
2. **`handleMessage` / `handleCallStart`** (`pipeline.ts`) runs onboarding or command.
3. **`parseIntent`** turns text into a structured intent (rule-based today).
4. **`evaluatePolicy`** applies tiered caps — never signed by an LLM.
5. **Send** parks a pending transfer → **PIN** (DTMF on voice, text elsewhere) → **`transferUsdc`**.
6. Ledger + policy audit rows are written; channel reply goes out on the same ingress.

---

## 3. Runtime components

| Component | Role | Entry |
|-----------|------|--------|
| **Orchestrator** | HTTP API, webhooks, FastAGI, CLI | `orchestrator/src/server.ts`, `agi/server.ts` |
| **Postgres** | Staging / Docker pack store | `DATABASE_URL` |
| **SQLite** | Local lab / tests | `DATABASE_PATH` |
| **Asterisk** | SIP / DID / softphone → AGI | `telephony/asterisk/` |
| **STT** | faster-whisper + espeak TTS | `telephony/stt/` |
| **Docker pack** | postgres + orchestrator + stt + asterisk | `docker-compose.yml` |
| **Frontend** | Landing / pitch (separate) | `hotline_front/` |

### Processes

- **`npm run start`** — HTTP `:8787` + FastAGI `:4573` (same Node process).
- **`npm run pack`** — Compose; AGI is **not** published publicly (Asterisk reaches `orchestrator:4573` on the Docker network).
- **`npm run telephony`** — Asterisk + STT only; AGI still on host.

---

## 4. Money path

### Default: Circle developer-controlled wallets

1. Set `CIRCLE_API_KEY` → `npm run circle:register-secret` → `CIRCLE_WALLET_SET_ID`.
2. `WALLET_MODE=circle` (default). **No silent fallback** to local EOAs — use `WALLET_MODE=local` or lab-only `ALLOW_LOCAL_FALLBACK=1`.
3. New users get an SCA wallet when Gas Station / SCA is enabled.
4. Transfers: Circle API → poll to COMPLETE (or `ASYNC_SETTLE` ack) → ArcScan link.
5. Smoke: `npm run circle:smoke`.

**Investor-safe claim:** Settlement path proven on Arc testnet. Arc has no public mainnet yet — testnet is the only network available, so this is the strongest claim the chain permits.

### Fallback: local EOAs (explicit only)

- Encrypted private keys in DB (`WALLET_SECRET`).
- Tests force `WALLET_MODE=local`.

### Pending claims (not unconsented wallets)

- Send to an unknown MSISDN → **escrow hold**, not a minted wallet.
- Recipient onboard → funds release; else expire/refund sender after `PENDING_CLAIM_DAYS`.
- Daily pending-claim cap per sender (griefing brake).

### Identity of funds

- **Caller phone** (or `tg:…`) owns a wallet row after onboard.
- Never speak hex when HotlineNS / phone labels exist.

---

## 5. Policy & identity tiers

| Tier | How you get it | Caps |
|------|----------------|------|
| **0** | Phone + name + PIN | Tight (`POLICY_T0_*`, defaults from base × 0.5) |
| **1** | `VERIFY ID …` (hashed national ID only) | Moderate |
| **2** | `ATTEST` / `ATTEST SIM` | Corridor |

- Policy outcomes: **reject** (hard ceiling / daily), **confirm** (needs PIN), **pass** (nanopay price).
- Decisions land in **`policy_audit`** → `GET /v1/audit/policy` (token required outside open lab).
- Staging forbids `SIM_ATTEST_MODE=mock` and `DEMO_SIMPLE=1`.

---

## 6. HotlineNS (shipped, deliberately off-chain)

App-owned name registry — **not** a gap vs ArcNS:

- `CLAIM alice` → `alice.hotline` → phone → wallet.
- `WHOIS alice` → confirms registration **without** returning MSISDN.
- Keeping names off-chain preserves revocation and reduces the privacy surface of “name → phone → wallet.”
- On-chain ArcNS can bind later; UX never depends on it.

---

## 7. Channels

| Channel | Account key | Webhook / path |
|---------|-------------|----------------|
| Voice | Caller ID E.164 | Asterisk → FastAGI |
| SMS Telnyx | E.164 | `POST /webhooks/sms/telnyx` (ed25519 or lab HMAC) |
| SMS Africa's Talking | E.164 | `POST /webhooks/sms/at` + `AT_WEBHOOK_SECRET` header |
| Generic SMS | E.164 | `POST /webhooks/sms` + `X-Hotline-Signature` |
| WhatsApp | Same E.164 as SMS | `GET|POST /webhooks/whatsapp` |
| Telegram | `tg:<chatId>` | `POST /webhooks/telegram` |
| Lab HTTP | any account | `POST /v1/message` (gated; see security) |

Live DID still needs a Telnyx / Zadarma trunk: set `SIP_*` + `PUBLIC_IP` in `.env` → `npm run trunk`.  
Readiness without secrets: `GET /v1/channels` (auth outside lab).

---

## 8. User journeys

### First call / text (forced onboard)

1. Welcome → ask first name.  
2. Create Arc wallet on this number.  
3. Set 4-digit PIN (voice: DTMF).  
4. Ready. Optional HotlineNS suggestion (“CLAIM alice”).

### Send

1. `send 10 usdt to +1555…` or `… to alice.hotline`.  
2. Policy: reject or ask for PIN.  
3. Confirm → **atomic idempotency claim** → Circle/local transfer → ledger.  
4. Reply on same channel; SMS receipt only for real `+` numbers.

### Identity upgrade

`VERIFY ID AB12` → tier 1 → higher soft/daily caps.  
`ATTEST` → tier 2 in lab mock; staging requires live/off.

---

## 9. Security & privacy (current posture)

| Control | Behavior |
|---------|----------|
| Lab HTTP | Open in lab unless `LAB_HTTP_API=0`; staging needs `LAB_HTTP_API=1` + `LAB_API_TOKEN` |
| Webhooks | `WEBHOOK_VERIFY=1` required in staging; Telnyx ed25519 preferred |
| PIN | scrypt (`v2:`); lockout after `PIN_MAX_FAILS`; `CHANGE PIN` / `RECOVER PIN` with cool-down |
| Idempotency | Claim-before-transfer |
| SIM / risk | `REPORT SIM` cool-down; recovery also sets cool-down; telco signal is the real fix |
| Caller ID | Treated as claim — larger amounts need `CALLBACK` verify window |
| Pending claims | Escrow, not ghost wallets; expiry refund |
| Audit | Hash-chained `policy_audit` |
| Custody | No silent Circle→local downgrade |
| Async settle | `ASYNC_SETTLE=1` ack-then-text for voice |

**Still open:** live telco SIM-change feed, real outbound callback on trunk, corridor cash-in/out escrow swap, Redis rate limits.

---

## 10. Data model (high level)

| Table | Purpose |
|-------|---------|
| `users` | Phone/account, name, pin_hash, wallet, identity_tier, SIM attest, hotline_name |
| `hotline_names` | Unique `.hotline` label → phone |
| `contacts` | Per-user address book |
| `ledger` | Sends / receives / nanopay |
| `sessions` | Pending send / awaiting name |
| `idempotency` | Send keys (pending → final result) |
| `policy_audit` | Gate decisions for compliance export |

---

## 11. Key modules (orchestrator)

| File | Responsibility |
|------|----------------|
| `pipeline.ts` | Onboard, dispatch intents, PIN confirm, execute send |
| `intent.ts` | Rule parser (send, claim, verify, attest, …) |
| `policy.ts` | Tier-aware caps |
| `identity.ts` / `hotlinens.ts` | Tiers + name registry |
| `wallets.ts` / `circle.ts` / `arc.ts` | Custody + Arc constants |
| `contacts.ts` | Payee resolution |
| `sms` / `whatsapp` / `telegram` / `ingress` | Channel adapters |
| `webhooks.ts` / `profile.ts` / `rateLimit.ts` | Verify, staging guards, limits |
| `db.ts` | SQLite + Postgres dual store |
| `marketplace.ts` | Price / optional x402 / fraud stub |
| `log.ts` | Structured JSON + redaction |

---

## 12. Ops cheat sheet

```bash
cp .env.example .env
npm install && npm test && npm run typecheck

# Lab process
npm run start

# Full pack
npm run pack
curl -s localhost:8787/health
curl -s "localhost:8787/health?deep=1"   # may need audit token outside lab

# Circle
npm run circle:register-secret
npm run circle:smoke

# Backup
npm run backup

# CI locally
npm test && docker build -t hotline.guru:local .
```

**Profiles**

- `HOTLINE_PROFILE=lab` — defaults for Encode demos.  
- `HOTLINE_PROFILE=staging` — hard refuse weak config; Postgres + Circle + webhook verify.

---

## 13. What works vs what’s next

> Full matrix: **[FUNCTIONALITY_AUDIT.md](./FUNCTIONALITY_AUDIT.md)** (2026-08-05). Below is the short cut.

### Works in lab (tested or clear smoke)

- Forced onboard → PIN → send / refuse ceiling  
- Spoken policy compile → PIN freeze → enforce  
- Pending-claim hold (unknown MSISDN) — fulfill on onboard  
- PIN lockout · HotlineNS · identity VERIFY (hash)  
- Hash-chained policy audit · no silent Circle→local fallback  
- Softphone AGI · flash balance · dial-a-rate · voice memo  
- x402 lab: discover / shop / buy / ask (mock SMS)  
- Marketing frontend modules + features  

### Partial (code yes — stub, mock, or no worker)

- RECOVER PIN / CALLBACK — **outbound call stub**  
- REPORT SIM cool-down — **manual**, no telco feed  
- Savings lock — code OK, thin tests  
- SMS / WA / TG — adapters OK, default **mock**  
- x402 call / research / fraud / proxy — need `MARKETPLACE_LIVE`  
- SIM ATTEST live — needs BlockRun pay  

### Blocked on external accounts / ops

- Live inbound DID + Telnyx/AT production  
- Live WhatsApp / Telegram tokens  
- Proven **funded** Circle send on Arc testnet in *your* console  
- Marketplace live nanopay (Gateway + `OPERATOR_ARC_ADDRESS`)  

### Missing

2. Live SIM-change from telco + real outbound callback.  
3. Corridor **cash-in/out** escrow swap with a licensed partner.  
4. Operator / product UI (frontend is pitch site only).  

HotlineNS off-chain is **not** a gap.

---

## 14. Mental model for demos

1. **Judge path:** softphone dials `hotline` → say name → set PIN → `send 2 usdt to +…` → DTMF PIN → ArcScan.  
2. **Chat path:** Telegram/WhatsApp/SMS same pipeline, reply on channel.  
3. **Refuse path:** `send 100…` → hard ceiling, no PIN dance.  
4. **Name path:** `CLAIM bob` → peer sends to `bob.hotline`.

Policy always wins over the model. The phone is the account. Circle holds the keys; the hotline holds the leash.

---

## Related docs

- [docs/FUNCTIONALITY_AUDIT.md](FUNCTIONALITY_AUDIT.md) — what works / partial / blocked  
- [README.md](../README.md) — quick start  
- [kb.md](../kb.md) — idea history / peers  
- [DEMO.md](../DEMO.md) — pitch script  
- [docs/PITCH_DECK.md](PITCH_DECK.md) — investor brief  
- [telephony/README.md](../telephony/README.md) — SIP / STT  
