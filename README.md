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
cp .env.example .env   # fill CIRCLE_* for real wallets (else soft-falls to local)
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

Default providers are `mock`. **Live DID/trunk** still needs accounts: copy `telephony/asterisk/pjsip.telnyx.conf.example` into `pjsip.conf`, set `INBOUND_DID`, and run with `HOTLINE_PROFILE=staging` + `WEBHOOK_VERIFY=1`. Check readiness: `GET /v1/channels`.

## Ops

```bash
npm run backup                    # Postgres dump or SQLite copy → data/backups/
HOTLINE_PROFILE=staging …         # refuses weak WALLET_SECRET / missing WEBHOOK_VERIFY / no Postgres
```

CI: `.github/workflows/ci.yml` runs typecheck, tests, and `docker build`.

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

Default: full onboard + PIN confirm (`DEMO_SIMPLE=0`). Voice collects PIN via **DTMF**. Unknown payee numbers get a real wallet immediately — when they later onboard, they claim that same wallet (balance already there).

## Wallets

- **Default: Circle** developer-controlled wallets on `ARC-TESTNET` (`WALLET_MODE=circle`)
  - One-time: `npm run circle:register-secret` (needs `CIRCLE_API_KEY`)
  - Then set `CIRCLE_WALLET_SET_ID`; smoke with `npm run circle:smoke`
  - Default `CIRCLE_ACCOUNT_TYPE=SCA` + Gas Station sponsorship on Arc testnet
  - Without `CIRCLE_*` creds the process soft-falls back to local EOAs (tests set `WALLET_MODE=local`)
- `WALLET_MODE=local`: encrypted viem EOAs on Arc — Encode lab without Circle console
- Policy audit export: `GET /v1/audit/policy` (JSON or `?format=csv`); set `AUDIT_EXPORT_TOKEN` in staging
- Transfers wait for confirmation and return ArcScan links
- Operator Circle **agent** wallet (CLI) still funds demos / optional `MARKETPLACE_LIVE=1` x402

## Layout

```
orchestrator/     HTTP + FastAGI + CLI + policy/intent/wallets
telephony/        Asterisk + STT (also pulled into root compose)
docker-compose.yml  all-in-one pack
scripts/smoke-rails.sh
kb.md             product knowledge base
DEMO.md           pitch script
```

## Docs

- [kb.md](kb.md) — idea, peers, marketplace, plan lock (§16)
- [DEMO.md](DEMO.md) — 2-minute judge script
