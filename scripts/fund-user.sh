#!/usr/bin/env bash
# Fund a hotline user from the lab treasury (recyclable).
# Usage: bash scripts/fund-user.sh <phone> [amount_usdc]
set -euo pipefail
cd "$(dirname "$0")/.."

PHONE="${1:?phone required}"
AMOUNT="${2:-0.5}"

if [[ -f .env ]]; then set -a; # shellcheck disable=SC1091
  source .env
  set +a
fi

bash scripts/ensure-funds.sh "$AMOUNT" || true

export PHONE AMOUNT
node --import tsx <<'EOF'
import { getUser, setUserName, setPin, normalizePhone } from "./orchestrator/src/lib/db.ts";
import { ensureWallet, hashPin } from "./orchestrator/src/lib/wallets.ts";
import {
  transferFromTreasury,
  getUsdcBalance,
  loadOrCreateLabWallets,
} from "./orchestrator/src/lib/lab.ts";

const phone = normalizePhone(process.env.PHONE!);
const amount = Number(process.env.AMOUNT!);
const lab = loadOrCreateLabWallets();

let user = getUser(phone);
if (!user) user = await ensureWallet(phone, "lab");
if (!user.name) setUserName(phone, "Lab");
if (!user.pin_hash) setPin(phone, hashPin(process.env.DEMO_PIN ?? "1234"));

const tBal = await getUsdcBalance(lab.treasury.address);
console.log("treasury", lab.treasury.address, "bal", tBal);
if (tBal < amount) {
  console.error("Treasury too low — run: bash scripts/ensure-funds.sh");
  console.error("Faucet: https://faucet.circle.com → Arc Testnet →", lab.treasury.address);
  process.exit(2);
}
const hash = await transferFromTreasury(user.wallet_address as `0x${string}`, amount);
console.log(`Funded ${user.wallet_address} with ${amount} USDC`);
console.log("tx", hash);
EOF

echo "Done. Wait ~5s, then: npm run cli -- --phone $PHONE BALANCE"
