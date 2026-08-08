/**
 * Arc Testnet swap assets (Circle App Kit / Swap Kit aliases).
 * Pairs: USDC ↔ EURC ↔ cirBTC (all six directions). USDC↔NATIVE is a no-op — never offered.
 */
import type { Address } from "viem";
import { USDC_ADDRESS } from "./arc.js";

export type SwapToken = "USDC" | "EURC" | "cirBTC";

export const SWAP_TOKENS: readonly SwapToken[] = ["USDC", "EURC", "cirBTC"] as const;

export const EURC_ADDRESS = (process.env.EURC_ADDRESS ??
  "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a") as Address;

export const CIRBTC_ADDRESS = (process.env.CIRBTC_ADDRESS ??
  "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF") as Address;

export const TOKEN_DECIMALS: Record<SwapToken, number> = {
  USDC: 6,
  EURC: 6,
  cirBTC: 8,
};

export const TOKEN_ADDRESS: Record<SwapToken, Address> = {
  USDC: USDC_ADDRESS,
  EURC: EURC_ADDRESS,
  cirBTC: CIRBTC_ADDRESS,
};

/** Spoken / SMS label for TTS. */
export function spokenToken(t: SwapToken): string {
  if (t === "EURC") return "euro";
  if (t === "cirBTC") return "circle bitcoin";
  return "USDC";
}

/** Map spoken aliases → Swap Kit token alias. */
export function parseSwapToken(raw: string): SwapToken | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (/^(usdc|usd|usdt|dollar|dollars|bucks?)$/.test(s)) return "USDC";
  if (/^(eurc|eur|euro|euros)$/.test(s)) return "EURC";
  if (/^(cirbtc|circbtc|cbtc|bitcoin|btc|wrappedbitcoin|wbtc|circlebitcoin)$/.test(s)) return "cirBTC";
  return null;
}

export function isValidSwapPair(tokenIn: SwapToken, tokenOut: SwapToken): boolean {
  return tokenIn !== tokenOut;
}

export const SWAP_PAIR_HINT =
  "USDC, euro (EURC), or circle bitcoin (cirBTC) — e.g. swap 5 USDC to euro";
