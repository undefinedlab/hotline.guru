import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getUser, upsertUser, type User } from "./db.js";
import {
  circleConfigured,
  circleCreateWallet,
  circleGasStationEnabled,
  circleTransferUsdc,
  circleWalletUsdcBalance,
  resolveWalletMode,
} from "./circle.js";
import {
  ARC_BLOCKCHAIN,
  ARC_CHAIN_ID,
  ARC_EXPLORER,
  ARC_FAUCET,
  ARC_RPC_URL,
  USDC_ADDRESS,
  addressUrl,
  arcTestnet,
  txUrl,
} from "./arc.js";
import { log } from "./log.js";

export { resolveWalletMode } from "./circle.js";

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL),
});

function secretKey(): Buffer {
  const secret = process.env.WALLET_SECRET ?? "dev-only-change-me";
  if (secret === "dev-only-change-me" && process.env.HOTLINE_PROFILE === "staging") {
    log.warn("WALLET_SECRET is still the default — set a strong secret in staging");
  }
  return scryptSync(secret, "hotline.guru", 32);
}

function encryptPk(pk: Hex): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(pk.slice(2), "hex")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptPk(blob: string): Hex {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return `0x${dec.toString("hex")}` as Hex;
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, `hotline:pin:${salt}`, 32).toString("hex");
  return `v2:${salt}:${hash}`;
}

function legacyPinHash(pin: string): string {
  return createHash("sha256").update(`hotline:${pin}`).digest("hex");
}

export function verifyPin(user: User, pin: string): boolean {
  if (!user.pin_hash) return false;
  if (user.pin_hash.startsWith("v2:")) {
    const parts = user.pin_hash.split(":");
    const salt = parts[1];
    const hash = parts[2];
    if (!salt || !hash) return false;
    const got = scryptSync(pin, `hotline:pin:${salt}`, 32).toString("hex");
    try {
      return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(hash, "hex"));
    } catch {
      return false;
    }
  }
  const legacy = legacyPinHash(pin);
  try {
    return timingSafeEqual(Buffer.from(legacy, "hex"), Buffer.from(user.pin_hash, "hex"));
  } catch {
    return user.pin_hash === legacy;
  }
}

export async function ensureWallet(phone: string, name?: string): Promise<User> {
  const existing = await getUser(phone);
  if (existing) {
    if (name && name !== existing.name) {
      return upsertUser({
        phone,
        name,
        wallet_address: existing.wallet_address,
        wallet_ref: existing.wallet_ref,
        pin_hash: existing.pin_hash,
      });
    }
    return existing;
  }

  if (resolveWalletMode() === "circle") {
    if (!circleConfigured()) {
      throw new Error(
        "WALLET_MODE=circle requires CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_SET_ID",
      );
    }
    const w = await circleCreateWallet(phone);
    return upsertUser({
      phone,
      name: name ?? null,
      wallet_address: w.address,
      wallet_ref: `circle:${w.walletId}`,
    });
  }

  const pk = `0x${randomBytes(32).toString("hex")}` as Hex;
  const account = privateKeyToAccount(pk);
  return upsertUser({
    phone,
    name: name ?? null,
    wallet_address: account.address,
    wallet_ref: encryptPk(pk),
  });
}

export async function getUsdcBalance(address: Address, walletRef?: string | null): Promise<number> {
  if (walletRef?.startsWith("circle:") && circleConfigured()) {
    const bal = await circleWalletUsdcBalance(walletRef.slice("circle:".length));
    if (bal != null) return bal;
  }
  const raw = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  return Number(formatUnits(raw, 6));
}

export async function checkArcRpc(): Promise<{ ok: boolean; block?: string; error?: string }> {
  try {
    const n = await publicClient.getBlockNumber();
    return { ok: true, block: n.toString() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function waitReceipt(hash: Hex): Promise<TransactionReceipt> {
  const timeout = Number(process.env.TX_RECEIPT_TIMEOUT_MS ?? 90_000);
  return publicClient.waitForTransactionReceipt({ hash, timeout });
}

export async function transferUsdc(params: {
  fromPhone: string;
  toAddress: Address;
  amountUsdc: number;
}): Promise<{ txHash: Hex; explorer: string }> {
  const user = await getUser(params.fromPhone);
  if (!user) throw new Error("User not found");

  if (resolveWalletMode() === "circle" || user.wallet_ref.startsWith("circle:")) {
    const walletId = user.wallet_ref.replace(/^circle:/, "");
    const { txHash } = await circleTransferUsdc({
      walletId,
      walletAddress: user.wallet_address,
      toAddress: params.toAddress,
      amountUsdc: params.amountUsdc,
    });
    const hash = txHash as Hex;
    return { txHash: hash, explorer: txUrl(hash) };
  }

  const pk = decryptPk(user.wallet_ref);
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(ARC_RPC_URL),
  });

  const amount = parseUnits(params.amountUsdc.toFixed(6), 6);
  const hash = await wallet.writeContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "transfer",
    args: [params.toAddress, amount],
  });

  const receipt = await waitReceipt(hash);
  if (receipt.status !== "success") {
    throw new Error(`Arc transfer reverted (${hash})`);
  }
  log.info("local arc transfer mined", { txHash: hash, block: receipt.blockNumber.toString() });
  return { txHash: hash, explorer: txUrl(hash) };
}

export function exportDepositInfo(user: User) {
  const gasStation = circleGasStationEnabled() || user.wallet_ref.startsWith("circle:");
  const mode = user.wallet_ref.startsWith("circle:") ? "circle" : resolveWalletMode();
  return {
    address: user.wallet_address,
    addressUrl: addressUrl(user.wallet_address),
    chain: ARC_BLOCKCHAIN,
    chainId: ARC_CHAIN_ID,
    usdc: USDC_ADDRESS,
    explorer: ARC_EXPLORER,
    faucet: ARC_FAUCET,
    note: gasStation && mode === "circle"
      ? "SCA wallet — Gas Station may sponsor fees on Arc testnet; still fund USDC for transfers"
      : "Request Arc Testnet USDC to this address",
    custody: mode,
    gasStation: mode === "circle" && circleGasStationEnabled(),
  };
}
