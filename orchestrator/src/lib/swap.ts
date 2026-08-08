/**
 * Arc Testnet swaps via Circle Swap Kit (USDC ↔ EURC ↔ cirBTC).
 * Circle DCW when wallet_ref is circle:*; local viem EOAs otherwise.
 */
import { createPublicClient, formatUnits, http, type Address } from "viem";
import { getUser } from "./db.js";
import { circleConfigured, resolveWalletMode } from "./circle.js";
import { ARC_RPC_URL, arcTestnet, txUrl } from "./arc.js";
import { log } from "./log.js";
import {
  TOKEN_ADDRESS,
  TOKEN_DECIMALS,
  type SwapToken,
  isValidSwapPair,
} from "./tokens.js";
import { unlockLocalPrivateKey } from "./wallets.js";

const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL),
});

const CHAIN = "Arc_Testnet" as const;

function kitConfig(): { kitKey?: string; slippageBps?: number } {
  let kitKey = process.env.KIT_KEY?.trim() || process.env.CIRCLE_KIT_KEY?.trim() || "";
  // Console paste often omits the KIT_KEY: prefix; SDK requires KIT_KEY:<id>:<secret>
  if (kitKey && !/^KIT_KEY:/i.test(kitKey) && kitKey.includes(":")) {
    kitKey = `KIT_KEY:${kitKey}`;
  }
  const slippage = Number(process.env.SWAP_SLIPPAGE_BPS ?? 300);
  return {
    ...(kitKey ? { kitKey } : {}),
    slippageBps: Number.isFinite(slippage) && slippage > 0 ? slippage : 300,
  };
}

export function swapConfigured(): boolean {
  const mode = resolveWalletMode();
  if (mode === "circle") return circleConfigured();
  return true;
}

export async function getTokenBalance(
  address: Address,
  token: SwapToken,
): Promise<number> {
  const raw = await publicClient.readContract({
    address: TOKEN_ADDRESS[token],
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [address],
  });
  return Number(formatUnits(raw, TOKEN_DECIMALS[token]));
}

function formatAmountIn(token: SwapToken, amount: number): string {
  const d = TOKEN_DECIMALS[token];
  return amount.toFixed(Math.min(d, 8));
}

function tokenAmountToString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object" && v !== null) {
    const o = v as { amount?: unknown; value?: unknown; toString?: () => string };
    if (o.amount != null) return String(o.amount);
    if (o.value != null) return String(o.value);
    if (typeof o.toString === "function") {
      const s = o.toString();
      if (s && s !== "[object Object]") return s;
    }
  }
  return String(v);
}

async function loadSwapKit() {
  const { SwapKit } = await import("@circle-fin/swap-kit");
  return new SwapKit();
}

async function buildFrom(phone: string, address: Address, walletRef: string) {
  const useCircle =
    resolveWalletMode() === "circle" || walletRef.startsWith("circle:");

  if (useCircle) {
    if (!circleConfigured()) {
      throw new Error("Swap needs CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET");
    }
    const { createCircleWalletsAdapter } = await import(
      "@circle-fin/adapter-circle-wallets"
    );
    const adapter = createCircleWalletsAdapter({
      apiKey: process.env.CIRCLE_API_KEY!,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    });
    return { adapter, chain: CHAIN, address };
  }

  void phone;
  const { createViemAdapterFromPrivateKey } = await import(
    "@circle-fin/adapter-viem-v2"
  );
  const privateKey = unlockLocalPrivateKey(walletRef);
  const adapter = createViemAdapterFromPrivateKey({ privateKey });
  return { adapter, chain: CHAIN };
}

export async function estimateArcSwap(params: {
  phone: string;
  tokenIn: SwapToken;
  tokenOut: SwapToken;
  amountIn: number;
}): Promise<{ estimatedOutput: string; fees?: unknown } | null> {
  if (!isValidSwapPair(params.tokenIn, params.tokenOut)) return null;
  const user = await getUser(params.phone);
  if (!user) return null;
  try {
    const kit = await loadSwapKit();
    const from = await buildFrom(params.phone, user.wallet_address as Address, user.wallet_ref);
    const estimate = await kit.estimate({
      from,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: formatAmountIn(params.tokenIn, params.amountIn),
      config: kitConfig(),
    });
    return {
      estimatedOutput: tokenAmountToString(
        (estimate as { estimatedOutput?: unknown }).estimatedOutput ??
          (estimate as { amountOut?: unknown }).amountOut,
      ),
      fees: (estimate as { fees?: unknown }).fees,
    };
  } catch (e) {
    log.warn("swap estimate failed", { err: String(e), phone: params.phone });
    return null;
  }
}

export async function executeArcSwap(params: {
  phone: string;
  tokenIn: SwapToken;
  tokenOut: SwapToken;
  amountIn: number;
}): Promise<{ txHash: string; amountOut: string; explorer: string }> {
  if (!isValidSwapPair(params.tokenIn, params.tokenOut)) {
    throw new Error("Invalid swap pair");
  }
  if (!(params.amountIn > 0) || !Number.isFinite(params.amountIn)) {
    throw new Error("Invalid swap amount");
  }

  const user = await getUser(params.phone);
  if (!user) throw new Error("User not found");

  const bal = await getTokenBalance(user.wallet_address as Address, params.tokenIn);
  if (bal + 1e-9 < params.amountIn) {
    throw new Error(
      `Insufficient ${params.tokenIn}: have ${bal.toFixed(6)}, need ${params.amountIn}`,
    );
  }

  const kit = await loadSwapKit();
  const from = await buildFrom(params.phone, user.wallet_address as Address, user.wallet_ref);
  const amountIn = formatAmountIn(params.tokenIn, params.amountIn);

  log.info("swap start", {
    phone: params.phone,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn,
  });

  const result = await kit.swap({
    from,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn,
    config: kitConfig(),
  });

  const txHash = String((result as { txHash?: string }).txHash ?? "");
  const amountOut = tokenAmountToString((result as { amountOut?: unknown }).amountOut);
  if (!txHash) {
    throw new Error("Swap completed without a transaction hash");
  }

  log.info("swap ok", {
    phone: params.phone,
    txHash,
    amountOut,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
  });

  return {
    txHash,
    amountOut,
    explorer: txUrl(txHash),
  };
}
