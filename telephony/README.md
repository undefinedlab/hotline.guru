# Asterisk inbound + local faster-whisper STT

Pattern adapted from [PTCIP](https://github.com/NOVA-privacy-first/PTCIP) — **no Twilio**.

Speech: **faster-whisper** (`tiny.en` on CPU) + **espeak-ng** TTS.

## Start

From repo root or `telephony/`:

```bash
cd telephony
docker compose up -d --build
# first boot downloads the whisper model (~75MB for tiny.en) — wait for healthy
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

| Env | Default | Notes |
|-----|---------|--------|
| `WHISPER_MODEL` | `tiny.en` | Fast CPU lab |
| | `base.en` | Better accuracy, slower |

Set in `telephony/.env` or compose: `WHISPER_MODEL=base.en`.

## Production trunk

Same as before — Zadarma/Telnyx in `asterisk/pjsip.conf`, `EXTERNAL_IP`, forward UDP 5060 + RTP.
