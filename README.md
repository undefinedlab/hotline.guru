# hotline.guru

Call or text your agent. It spends **USDC on Arc** under a deterministic policy gate.

> Telephony UI → policy leash → Circle / local Arc wallets → x402 marketplace → human-readable payees

## Quick start

```bash
cp .env.example .env
npm install
npm test
# The demo — one sentence (USDT spoken → USDC on Arc):
npm run cli -- --phone +15550001 "send 10 usdt to +15550002"
# Fund caller once: bash scripts/fund-user.sh +15550001 12
npm run demo                               # full judge path
npm run start                              # HTTP :8787 + FastAGI :4573
```

Rails smoke (Circle CLI + Asterisk config):

```bash
bash scripts/smoke-rails.sh
```

## Cheap inbound voice (not Twilio)

```bash
npm run telephony    # Asterisk + faster-whisper STT (:8090)
npm run start        # AGI speaks/listens via STT
bash scripts/smoke-stt.sh
```

Softphone `hotline` / `hotline-lab` → dial `hotline` → **say** your name / command.  
See [telephony/README.md](telephony/README.md).

## SMS (cheap providers)

Set `SMS_PROVIDER=telnyx` or `africas_talking` in `.env`. Webhooks:

- `POST /webhooks/sms` — generic `From` + `Body`
- `POST /webhooks/sms/telnyx`
- `POST /webhooks/sms/at`

Default `SMS_PROVIDER=mock` logs outbound receipts.

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
| `balance` / `history` | Check funds / last txs |
| `send 100 usdt to +1…` | Policy hard-refuse (no PIN) |

Default: full onboard + PIN confirm (`DEMO_SIMPLE=0`). Voice collects PIN via **DTMF**. Unknown payee numbers get a real wallet immediately — when they later onboard, they claim that same wallet (balance already there).

## Wallets

- `WALLET_MODE=local` (default): encrypted EOAs on Arc via viem — works for Encode demos.
- `WALLET_MODE=circle`: wire Circle developer-controlled wallets (`CIRCLE_API_KEY`, etc.).
- Operator Circle **agent** wallet (CLI session) funds demos / optional `MARKETPLACE_LIVE=1` x402 pays.

## Layout

```
orchestrator/     HTTP + FastAGI + CLI + policy/intent/wallets
telephony/asterisk/   cheap SIP inbound
scripts/smoke-rails.sh
kb.md             product knowledge base
DEMO.md           pitch script
```

## Docs

- [kb.md](kb.md) — idea, peers, marketplace, plan lock (§16)
- [DEMO.md](DEMO.md) — 2-minute judge script
