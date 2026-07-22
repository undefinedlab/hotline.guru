#!/usr/bin/env bash
# Smoke faster-whisper STT (+ optional round-trip via espeak)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p telephony/shared

STT_URL="${STT_URL:-http://127.0.0.1:8090}"

echo "== STT health =="
curl -sf "$STT_URL/health" | tee /tmp/stt-health.json
echo

WAV=telephony/shared/smoke-in.wav
PHRASE="send 10 usdt to plus 1 5 5 5 1 2 3 0 0 0 2"

if command -v espeak-ng >/dev/null 2>&1; then
  espeak-ng -v en-us -s 120 -w "$WAV" "$PHRASE"
elif command -v espeak >/dev/null 2>&1; then
  espeak -v en -s 120 -w "$WAV" "$PHRASE"
else
  curl -sf -X POST "$STT_URL/tts" -H 'content-type: application/json' \
    -d "{\"text\":\"$PHRASE\",\"id\":\"smoke\"}" >/tmp/tts.json
  WAV=telephony/shared/tts-smoke.wav
fi

echo "== Transcribe $WAV =="
curl -sf -X POST "$STT_URL/transcribe" -F "file=@${WAV}" | tee /tmp/stt-out.json
echo
node --import tsx -e "
import { normalizeTranscript } from './orchestrator/src/lib/stt.ts';
import { parseIntent } from './orchestrator/src/lib/intent.ts';
import fs from 'fs';
const raw = JSON.parse(fs.readFileSync('/tmp/stt-out.json','utf8')).text;
const n = normalizeTranscript(raw);
const i = parseIntent(n);
console.log('RAW ', raw);
console.log('NORM', n);
console.log('INTENT', i);
"
