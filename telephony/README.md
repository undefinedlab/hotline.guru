# Asterisk inbound + local faster-whisper STT

Pattern adapted from [PTCIP](https://github.com/NOVA-privacy-first/PTCIP) — **no Twilio**.

Speech: **faster-whisper** (`small.en` on CPU by default) + Piper / espeak TTS.

## Start

From repo root or `telephony/`:

```bash
cd telephony
docker compose up -d --build
# first boot downloads the whisper model (~500MB for small.en) — wait for healthy
curl -s localhost:8090/health
```

Orchestrator on the host (AGI `:4573`):

```bash
# repo root
npm run start
```

Shared recordings: `telephony/shared` ↔ Asterisk/STT `/shared`.

## Softphone lab

1. Register Linphone → `hotline` / `hotline-lab` @ host:5060  
2. Dial `hotline`  
3. Hear greeting → say your name → say `send 10 USDT to …`  
4. Agent replies with espeak TTS  

If STT is down, keypad (amount `#` → phone `#`) still works.

## Smoke without a phone

```bash
bash scripts/smoke-stt.sh
```

## Models

| `WHISPER_MODEL` | Rough size | On a 4GB CPU VPS |
|-----------------|------------|------------------|
| `tiny.en` | ~75MB | Fast, often mangles telephony |
| `base.en` | ~140MB | Next step up, still light |
| `small.en` | ~500MB | **Default** — best skill/cost for voice |
| `medium.en` | ~1.5GB | Slow + RAM-hungry without GPU — skip here |

Set in `.env`: `WHISPER_MODEL=small.en`.

## Production trunk

Same as before — Zadarma/Telnyx via `SIP_*` + `PUBLIC_IP` in `.env` → `npm run trunk`, forward UDP 5060 + RTP.
