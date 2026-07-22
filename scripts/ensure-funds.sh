#!/usr/bin/env bash
# Ensure lab treasury exists + has USDC. Auto-faucet when low.
# Usage: bash scripts/ensure-funds.sh [min_usdc]
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then set -a; # shellcheck disable=SC1091
  source .env
  set +a
fi

export MIN_USDC="${1:-1}"
export OPERATOR_ARC_ADDRESS="${OPERATOR_ARC_ADDRESS:-0x161102d980f44ad03fb532730d6cad8fb3857de5}"
export USDC_ADDRESS="${USDC_ADDRESS:-0x3600000000000000000000000000000000000000}"

node --import tsx <<'EOF'
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  loadOrCreateLabWallets,
  getUsdcBalance,
  requestFaucet,
} from "./orchestrator/src/lib/lab.ts";

const exec = promisify(execFile);
const MIN = Number(process.env.MIN_USDC ?? 1);
const OPERATOR = process.env.OPERATOR_ARC_ADDRESS!;
const USDC = process.env.USDC_ADDRESS!;

const lab = loadOrCreateLabWallets();
console.log("treasury", lab.treasury.address);
console.log("sinkPhone", lab.sinkPhone);

async function operatorBal(): Promise<number> {
  try {
    const { stdout } = await exec(
      "circle",
      ["wallet", "balance", "--address", OPERATOR, "--chain", "ARC-TESTNET", "--output", "json"],
      { timeout: 30_000 },
    );
    const bals = JSON.parse(stdout)?.data?.balances ?? [];
    return bals.reduce((m: number, b: { amount: string }) => Math.max(m, Number(b.amount) || 0), 0);
  } catch {
    return 0;
  }
}

async function topUpFromOperator(need: number) {
  const amt = Math.max(need, 1).toFixed(2);
  console.log(`circle: ${amt} USDC operator → treasury`);
  await exec(
    "circle",
    [
      "wallet",
      "transfer",
      lab.treasury.address,
      "--amount",
      amt,
      "--token",
      USDC,
      "--address",
      OPERATOR,
      "--chain",
      "ARC-TESTNET",
      "--output",
      "json",
    ],
    { timeout: 120_000 },
  );
}

let tBal = await getUsdcBalance(lab.treasury.address);
console.log("treasuryBal", tBal);

if (tBal < MIN) {
  console.log(`below ${MIN} — topping up`);
  let oBal = await operatorBal();
  console.log("operatorBal", oBal);

  if (oBal < MIN) {
    console.log("requesting faucet for operator + treasury…");
    for (const addr of [OPERATOR, lab.treasury.address]) {
      const drip = await requestFaucet(addr);
      console.log(addr.slice(0, 10) + "…", drip.detail);
    }
    console.log("waiting 25s for drips…");
    await new Promise((r) => setTimeout(r, 25_000));
    oBal = await operatorBal();
    tBal = await getUsdcBalance(lab.treasury.address);
    console.log("after faucet operator", oBal, "treasury", tBal);
  }

  if (oBal >= 1 && tBal < MIN) {
    try {
      await topUpFromOperator(MIN - tBal + 0.5);
      await new Promise((r) => setTimeout(r, 12_000));
      tBal = await getUsdcBalance(lab.treasury.address);
    } catch (e) {
      console.error("operator→treasury failed:", e instanceof Error ? e.message : e);
    }
  }
}

tBal = await getUsdcBalance(lab.treasury.address);
console.log("FINAL treasury", tBal, lab.treasury.address);
if (tBal < MIN) {
  console.error(`Still low (${tBal}).`);
  console.error(`1) Set CIRCLE_API_KEY in .env for auto-drip`);
  console.error(`2) Or https://faucet.circle.com → Arc Testnet → ${lab.treasury.address}`);
  process.exit(2);
}
EOF
