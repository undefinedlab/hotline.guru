#!/usr/bin/env bash
# Full onboard + PIN-confirmed send to another phone (provisions receiver wallet).
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_PATH="${DATABASE_PATH:-./data/demo.db}"
export DEMO_SIMPLE="${DEMO_SIMPLE:-0}"
export DEMO_PIN="${DEMO_PIN:-1234}"
CALLER="${DEMO_CALLER:-+15551230001}"
NAME="${DEMO_NAME:-Ben}"
RECV="${DEMO_RECV:-+15551230002}"
SEND_AMT="${DEMO_SEND_AMT:-0.1}"
FUND_AMT="${DEMO_FUND_AMT:-0.5}"

rm -f "$DATABASE_PATH" "${DATABASE_PATH}-wal" "${DATABASE_PATH}-shm" 2>/dev/null || true
mkdir -p "$(dirname "$DATABASE_PATH")" data

cli() {
  local phone="$1"; shift
  npm run cli -- --phone "$phone" "$@"
}

echo "======== Ensure treasury / faucet ========"
bash scripts/ensure-funds.sh "$FUND_AMT"

echo "======== Onboard caller: welcome → name → PIN ========"
cli "$CALLER" hi
cli "$CALLER" "$NAME"
cli "$CALLER" "PIN $DEMO_PIN"
cli "$CALLER" hi

echo "======== Fund caller $FUND_AMT ========"
bash scripts/fund-user.sh "$CALLER" "$FUND_AMT"
sleep 8
cli "$CALLER" BALANCE

echo "======== Send $SEND_AMT USDC to phone $RECV (provisions wallet) ========"
cli "$CALLER" "send $SEND_AMT usdt to $RECV"
cli "$CALLER" "CONFIRM $DEMO_PIN"

echo "======== Receiver later onboards — same wallet ========"
cli "$RECV" hi
cli "$RECV" "Sam"
cli "$RECV" "PIN 9999"
cli "$RECV" BALANCE

echo "======== Policy hard refuse ========"
cli "$CALLER" "send 100 usdt to $RECV" || true

echo "======== Done ========"
