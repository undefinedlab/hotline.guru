#!/usr/bin/env bash
# Phase 0 rail smoke (no secrets required for inspect)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Circle wallet status =="
circle wallet status --output json | head -c 400
echo

echo "== Arc agent wallet =="
circle wallet list --chain ARC-TESTNET --type agent --output json

echo "== Price service inspect (x402) =="
circle services inspect "https://api.aisa.one/apis/v2/coingecko/simple/price" --output json \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d['status'], d.get('price'), d.get('chains',[])[:3])"

echo "== Asterisk compose config =="
test -f telephony/asterisk/docker-compose.yml && echo OK_asterisk_compose

echo "Rails smoke done. For live x402 pay: fund Gateway on BASE + MARKETPLACE_LIVE=1"
