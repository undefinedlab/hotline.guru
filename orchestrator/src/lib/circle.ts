/**
 * Circle developer-controlled wallets on Arc.
 *
 * Env:
 *   CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET + CIRCLE_WALLET_SET_ID
 *   CIRCLE_ACCOUNT_TYPE=SCA|EOA  (default SCA — Gas Station on Arc testnet)
 *   CIRCLE_GAS_STATION=1|0       (1 forces SCA; 0 forces EOA)
 *
 * Default money path is Circle. Lab/tests: WALLET_MODE=local.
 * Register entity secret once: npm run circle:register-secret
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { ARC_BLOCKCHAIN, USDC_ADDRESS } from "./arc.js";
import { log } from "./log.js";

type CircleClient = ReturnType<typeof initiateDeveloperControlledWalletsClient>;

let client: CircleClient | null = null;

export function circleConfigured(): boolean {
  return Boolean(
    process.env.CIRCLE_API_KEY &&
      process.env.CIRCLE_ENTITY_SECRET &&
      process.env.CIRCLE_WALLET_SET_ID,
  );
}

let warnedMissingCircle = false;

/**
 * Resolve custody backend.
 * Default: circle (when creds present). Explicit WALLET_MODE=local for lab EOAs.
 * If WALLET_MODE=circle (or unset) without creds → soft-fallback to local with a warn.
 */
export function resolveWalletMode(): "circle" | "local" {
  const raw = (process.env.WALLET_MODE ?? "circle").toLowerCase().trim();
  if (raw === "local") return "local";
  if (circleConfigured()) return "circle";
  if (!warnedMissingCircle && (raw === "circle" || !process.env.WALLET_MODE)) {
    warnedMissingCircle = true;
    log.warn(
      "Circle is the default money path but CIRCLE_* creds are missing — using local EOAs. Set CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_SET_ID (or WALLET_MODE=local).",
    );
  }
  return "local";
}

/** Gas Station needs SCA wallets on Arc (testnet has a default policy). Default: SCA. */
export function circleAccountType(): "EOA" | "SCA" {
  if (process.env.CIRCLE_GAS_STATION === "0") return "EOA";
  if (process.env.CIRCLE_GAS_STATION === "1") return "SCA";
  const t = (process.env.CIRCLE_ACCOUNT_TYPE ?? "SCA").toUpperCase();
  return t === "EOA" ? "EOA" : "SCA";
}

export function circleGasStationEnabled(): boolean {
  return circleAccountType() === "SCA";
}

function getClient(): CircleClient {
  if (!circleConfigured()) {
    throw new Error(
      "WALLET_MODE=circle needs CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_SET_ID",
    );
  }
  if (!client) {
    client = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY!,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    });
  }
  return client;
}

export async function circleCreateWallet(phone: string): Promise<{
  walletId: string;
  address: string;
  accountType: "EOA" | "SCA";
}> {
  const c = getClient();
  const walletSetId = process.env.CIRCLE_WALLET_SET_ID!;
  const accountType = circleAccountType();
  const res = await c.createWallets({
    accountType,
    blockchains: [ARC_BLOCKCHAIN] as never,
    count: 1,
    walletSetId,
  });
  const w = res.data?.wallets?.[0];
  if (!w?.id || !w.address) {
    log.error("circle create wallet empty", { data: res.data, phone });
    throw new Error("Circle create wallet: empty response");
  }
  log.info("circle wallet created", {
    phone,
    walletId: w.id,
    address: w.address,
    accountType,
    gasStation: accountType === "SCA",
  });
  return { walletId: w.id, address: w.address, accountType };
}

const TERMINAL = new Set(["COMPLETE", "FAILED", "CANCELLED", "DENIED"]);

export async function circleTransferUsdc(params: {
  walletId: string;
  walletAddress?: string;
  toAddress: string;
  amountUsdc: number;
}): Promise<{ txHash: string; id: string; state: string }> {
  const c = getClient();
  const amount = params.amountUsdc.toFixed(6);

  const transferResponse = await c.createTransaction({
    walletId: params.walletId,
    tokenAddress: USDC_ADDRESS,
    blockchain: ARC_BLOCKCHAIN,
    destinationAddress: params.toAddress,
    amount: [amount],
    fee: {
      type: "level",
      config: { feeLevel: (process.env.CIRCLE_FEE_LEVEL as "LOW" | "MEDIUM" | "HIGH") ?? "MEDIUM" },
    },
  } as unknown as Parameters<CircleClient["createTransaction"]>[0]);

  const transactionId = transferResponse.data?.id;
  let currentState = transferResponse.data?.state ?? "";
  if (!transactionId) {
    throw new Error("Circle transfer: no transaction id returned");
  }

  log.info("circle transfer initiated", {
    id: transactionId,
    state: currentState,
    gasStation: circleGasStationEnabled(),
  });

  let txHash = "";
  const maxPolls = Number(process.env.CIRCLE_TX_POLL_MAX ?? 40);
  for (let i = 0; i < maxPolls && !TERMINAL.has(currentState); i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await c.getTransaction({ id: transactionId });
    const tx = poll.data?.transaction;
    currentState = tx?.state ?? "";
    txHash = (tx as { txHash?: string } | undefined)?.txHash ?? txHash;
    log.debug("circle transfer poll", { id: transactionId, state: currentState });
  }

  if (currentState !== "COMPLETE") {
    log.error("circle transfer not complete", { id: transactionId, state: currentState });
    throw new Error(`Circle transfer ended in state: ${currentState || "unknown"}`);
  }

  log.info("circle transfer complete", { id: transactionId, txHash });
  return { txHash: txHash || transactionId, id: transactionId, state: currentState };
}

export async function circleWalletUsdcBalance(walletId: string): Promise<number | null> {
  try {
    const c = getClient();
    const res = await c.getWalletTokenBalance({ id: walletId });
    const balances = res.data?.tokenBalances ?? [];
    const usdc = balances.find(
      (b) =>
        b.token?.symbol === "USDC" ||
        (b.token as { tokenAddress?: string } | undefined)?.tokenAddress?.toLowerCase() ===
          USDC_ADDRESS.toLowerCase(),
    );
    if (!usdc?.amount) return 0;
    return Number(usdc.amount);
  } catch (e) {
    log.warn("circle balance failed", { walletId, err: String(e) });
    return null;
  }
}

export async function circleHealth(): Promise<{ ok: boolean; error?: string }> {
  if (!circleConfigured()) {
    return { ok: false, error: "circle not configured" };
  }
  try {
    getClient();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
