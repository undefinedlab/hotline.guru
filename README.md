# hotline.guru

Call or text your agent. It spends **USDC on Arc** under a deterministic policy gate.

> Telephony UI → policy leash → Circle / local Arc wallets → x402 marketplace → human-readable payees

## Quick start

```bash
cp .env.example .env
# Add CIRCLE_API_KEY → npm run circle:register-secret → set CIRCLE_WALLET_SET_ID
npm install
npm test
# The demo — one sentence (USDT spoken → USDC on Arc):
npm run cli -- --phone +15550001 "send 10 usdt to +15550002"
# Fund caller once: bash scripts/fund-user.sh +15550001 12
npm run demo                               # full judge path
npm run start                              # HTTP :8787 + FastAGI :4573
```

### Docker pack (orchestrator + Postgres + Asterisk + STT)

```bash
cp .env.example .env   # fill CIRCLE_* for real wallets; lab may set WALLET_MODE=local
npm run pack           # docker compose up -d --build
curl localhost:8787/health?deep=1
npm run pack:logs
npm run pack:down
```

Softphone `hotline` / `hotline-lab` → dial `hotline` (Asterisk → AGI on `orchestrator:4573`).

Rails smoke (Circle CLI + Asterisk config):

```bash
bash scripts/smoke-rails.sh
```

## Cheap inbound voice (not Twilio)

```bash
npm run telephony    # Asterisk + STT only (host AGI)
# or: npm run pack   # full stack including orchestrator
npm run start        # AGI speaks/listens via STT (host mode)
bash scripts/smoke-stt.sh
```

Softphone `hotline` / `hotline-lab` → dial `hotline` → **say** your name / command.  
See [telephony/README.md](telephony/README.md).

## SMS / WhatsApp / Telegram

Set `SMS_PROVIDER=telnyx` or `africas_talking` in `.env`. Webhooks:

- `POST /webhooks/sms` — generic `From` + `Body` (`X-Hotline-Signature`)
- `POST /webhooks/sms/telnyx` — Telnyx ed25519 (`TELNYX_PUBLIC_KEY`) or lab HMAC
- `POST /webhooks/sms/at` — Africa's Talking + `AT_WEBHOOK_SECRET`
- `GET|POST /webhooks/whatsapp` — Meta Cloud API
- `POST /webhooks/telegram` — Bot API

Default providers are `mock`. **Live DID/trunk** still needs an account: set `SIP_USER` / `SIP_PASSWORD` / `SIP_TRUNK_HOST` (`sip.telnyx.com` or `pbx.zadarma.com`) / `PUBLIC_IP` / `INBOUND_DID` in `.env`, then `npm run trunk` generates `telephony/asterisk/pjsip.conf` (gitignored — never commit it). `npm run pack` and `npm run telephony` do this for you. Run public with `HOTLINE_PROFILE=staging` + `WEBHOOK_VERIFY=1`. Check readiness: `GET /v1/channels`.

## Ops

```bash
npm run backup                    # Postgres dump or SQLite copy → data/backups/
HOTLINE_PROFILE=staging …         # refuses weak WALLET_SECRET / DEMO_SIMPLE / mock SIM / missing WEBHOOK_VERIFY
```

Security defaults: FastAGI not published from compose; lab HTTP API locked outside lab (`LAB_HTTP_API` + `LAB_API_TOKEN`); PINs use scrypt; logs hash phone fields; WHOIS does not return MSISDN.

CI: `.github/workflows/ci.yml` runs typecheck, tests, `npm audit`, and `docker build`.

## HTTP lab API

```bash
curl -X POST localhost:8787/v1/message \
  -H 'content-type: application/json' \
  -d '{"phone":"+15550001","text":"BALANCE"}'
```

## Commands

| You say | What happens |
|--------|----------------|
| *(first call)* | Welcome → name → Arc wallet on your number → set PIN → thanks |
| `PIN 1234` | Set / change PIN |
| `send 10 usdt to +15551234567` | Pays that **phone’s** Arc wallet (created if new) — confirm with PIN |
| `yes 1234` / keypad PIN | Confirms the pending send |
| `CLAIM alice` / `send 2 to alice.hotline` | HotlineNS payee |
| `VERIFY ID …` / `ATTEST` / `IDENTITY` | Identity tiers → higher caps |
| `balance` / `history` | Check funds / last txs |
| `send 100 usdt to +1…` | Policy hard-refuse (no PIN) |

Default: full onboard + PIN confirm (`DEMO_SIMPLE=0`). Voice collects PIN via **DTMF**. Unknown payee numbers get an **escrow pending claim** (not an unconsented wallet); they receive funds on first onboard, or funds return to sender after expiry.

PIN lockout after repeated failures (`PIN_MAX_FAILS`). Recovery: `RECOVER PIN` → outbound code → `RECOVER CONFIRM <code> <newpin>` with risk cool-down. Change: `CHANGE PIN <old> <new>`.

## Wallets

- **Default: Circle** developer-controlled wallets on **Arc Testnet** (`WALLET_MODE=circle`)
  - Settlement path proven on Arc testnet; **mainnet pending Circle production credentials**
  - One-time: `npm run circle:register-secret` (needs `CIRCLE_API_KEY`)
  - Then set `CIRCLE_WALLET_SET_ID`; smoke with `npm run circle:smoke`
  - Default `CIRCLE_ACCOUNT_TYPE=SCA` + Gas Station on Arc testnet
  - **No silent local fallback** — use `WALLET_MODE=local` or lab-only `ALLOW_LOCAL_FALLBACK=1`
- `WALLET_MODE=local`: encrypted viem EOAs on Arc — Encode lab without Circle console
- Policy audit is hash-chained (`prev_hash` / `entry_hash`); export: `GET /v1/audit/policy`
- Transfers wait for confirmation (or `ASYNC_SETTLE=1` for voice-friendly ack) and return ArcScan links
- Operator Circle **agent** wallet (CLI) still funds demos / optional `MARKETPLACE_LIVE=1` x402

## Layout

```
orchestrator/     HTTP + FastAGI + CLI + policy/intent/wallets
telephony/        Asterisk + STT (also pulled into root compose)
docker-compose.yml  all-in-one pack
docs/HANDOVER.md          features, test results, engineer handover
docs/CLEAR_DEMO_DID.md    live call→onboard→transfer: providers + gaps
docs/FUNCTIONALITY_AUDIT.md
docs/SYSTEM_REVIEW.md
scripts/smoke-rails.sh
kb.md             product knowledge base
DEMO.md           pitch script
```

## Docs

- [docs/SYSTEM_REVIEW.md](docs/SYSTEM_REVIEW.md) — what we have and how it works
- [kb.md](kb.md) — idea, peers, marketplace, plan lock (§16)
- [DEMO.md](DEMO.md) — 2-minute judge script
- [docs/PITCH_DECK.md](docs/PITCH_DECK.md) — investor brief
