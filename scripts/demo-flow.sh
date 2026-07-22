#!/usr/bin/env bash
# Register lab sink phone → treasury address in the active DB, then tiny demo send.
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_PATH="${DATABASE_PATH:-./data/demo.db}"
export DEMO_SIMPLE="${DEMO_SIMPLE:-1}"
CALLER="${DEMO_CALLER:-+15551230001}"
NAME="${DEMO_NAME:-Ben}"
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

# Resolve sink address + register phone mapping
SINK_JSON="$(node --import tsx -e '
import { loadOrCreateLabWallets } from "./orchestrator/src/lib/lab.ts";
const lab = loadOrCreateLabWallets();
console.log(JSON.stringify(lab));
')"
SINK_ADDR="$(printf '%s' "$SINK_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["treasury"]["address"])')"
SINK_PHONE="$(printf '%s' "$SINK_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["sinkPhone"])')"
echo "sink $SINK_PHONE → $SINK_ADDR (recycles to treasury)"

echo "======== First call: ask name ========"
cli "$CALLER" hi
cli "$CALLER" "$NAME"
cli "$CALLER" hi

echo "======== Fund caller $FUND_AMT from treasury ========"
bash scripts/fund-user.sh "$CALLER" "$FUND_AMT"
sleep 8
cli "$CALLER" BALANCE

echo "======== THE CALL: send $SEND_AMT usdt to sink ========"
# Pay to treasury address directly (we control it)
cli "$CALLER" "send $SEND_AMT usdt to $SINK_ADDR"

echo "======== Treasury balance (should have grown) ========"
node --import tsx -e '
import { loadOrCreateLabWallets, getUsdcBalance } from "./orchestrator/src/lib/lab.ts";
const lab = loadOrCreateLabWallets();
console.log("treasury", lab.treasury.address, await getUsdcBalance(lab.treasury.address));
'

echo "======== Policy still works ========"
cli "$CALLER" "send 100 usdt to $SINK_ADDR" || true

echo "======== Done ========"
