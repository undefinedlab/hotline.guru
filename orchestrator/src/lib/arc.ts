/**
 * Arc network constants — single source for RPC, chain id, USDC, explorer.
 */
import { defineChain, type Address, type Chain } from "viem";

export const ARC_RPC_URL = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
export const ARC_CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? 5042002);
export const ARC_BLOCKCHAIN = process.env.CIRCLE_BLOCKCHAIN ?? "ARC-TESTNET";
export const USDC_ADDRESS = (process.env.USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000") as Address;
export const ARC_EXPLORER =
  process.env.ARC_EXPLORER ?? "https://testnet.arcscan.app";
export const ARC_FAUCET = "https://faucet.circle.com";

/** viem chain definition for Arc Testnet (USDC-native gas). */
export const arcTestnet: Chain = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [ARC_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: ARC_EXPLORER },
  },
  testnet: true,
});

export function txUrl(txHash: string): string {
  return `${ARC_EXPLORER}/tx/${txHash}`;
}

export function addressUrl(address: string): string {
  return `${ARC_EXPLORER}/address/${address}`;
}
