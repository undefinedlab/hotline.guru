#!/usr/bin/env tsx
/**
 * Smoke Circle DCW on Arc Testnet.
 * Requires: CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_SET_ID
 *
 *   npm run circle:smoke
 */
import { loadEnv } from "../lib/env.js";
loadEnv();

import { ARC_BLOCKCHAIN, ARC_RPC_URL, USDC_ADDRESS, txUrl } from "../lib/arc.js";
import {
  circleConfigured,
  circleCreateWallet,
  circleHealth,
  circleWalletUsdcBalance,
} from "../lib/circle.js";
import { checkArcRpc } from "../lib/wallets.js";

async function main() {
  console.log("Arc RPC", ARC_RPC_URL, "blockchain", ARC_BLOCKCHAIN, "USDC", USDC_ADDRESS);
  const arc = await checkArcRpc();
  console.log("Arc RPC:", arc);

  if (!circleConfigured()) {
    console.error(
      "Missing Circle config. Set CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_SET_ID",
    );
    process.exit(1);
  }

  const health = await circleHealth();
  console.log("Circle client:", health);

  const phone = process.env.CIRCLE_SMOKE_PHONE ?? `+1555${Date.now().toString().slice(-7)}`;
  console.log("Creating wallet for", phone);
  const w = await circleCreateWallet(phone);
  console.log("Wallet", w);
  console.log("Explorer", `https://testnet.arcscan.app/address/${w.address}`);

  const bal = await circleWalletUsdcBalance(w.walletId);
  console.log("USDC balance:", bal);
  console.log("Fund via", "https://faucet.circle.com → Arc Testnet →", w.address);
  console.log("Done. Sample tx url helper:", txUrl("0x…"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
