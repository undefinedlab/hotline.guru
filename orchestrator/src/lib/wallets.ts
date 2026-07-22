import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getUser, upsertUser, type User } from "./db.js";

const ARC_RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const USDC = (process.env.USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000") as Address;
const MODE = process.env.WALLET_MODE ?? "local";

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
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

const publicClient = createPublicClient({
  transport: http(ARC_RPC),
});

function secretKey(): Buffer {
  const secret = process.env.WALLET_SECRET ?? "dev-only-change-me";
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
  return createHash("sha256").update(`hotline:${pin}`).digest("hex");
}

export function verifyPin(user: User, pin: string): boolean {
  if (!user.pin_hash) return false;
  return user.pin_hash === hashPin(pin);
}

/** Create or return existing wallet for phone. */
export async function ensureWallet(phone: string, name?: string): Promise<User> {
  const existing = getUser(phone);
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

  if (MODE === "circle") {
    throw new Error(
      "WALLET_MODE=circle requires Circle developer-controlled wallet provisioning (set CIRCLE_API_KEY / ENTITY_SECRET / WALLET_SET_ID). Use WALLET_MODE=local for lab.",
    );
  }

  const pk = `0x${randomBytes(32).toString("hex")}` as Hex;
  const account = privateKeyToAccount(pk);
  const ref = encryptPk(pk);
  return upsertUser({
    phone,
    name: name ?? null,
    wallet_address: account.address,
    wallet_ref: ref,
  });
}

export async function getUsdcBalance(address: Address): Promise<number> {
  const raw = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  return Number(formatUnits(raw, 6));
}

export async function transferUsdc(params: {
  fromPhone: string;
  toAddress: Address;
  amountUsdc: number;
}): Promise<{ txHash: Hex }> {
  const user = getUser(params.fromPhone);
  if (!user) throw new Error("User not found");

  if (MODE === "circle") {
    throw new Error("Circle SDK transfer not configured — use WALLET_MODE=local or wire CIRCLE_* keys");
  }

  const pk = decryptPk(user.wallet_ref);
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    account,
    transport: http(ARC_RPC),
  });

  const amount = parseUnits(params.amountUsdc.toFixed(6), 6);
  const hash = await wallet.writeContract({
    chain: {
      id: Number(process.env.ARC_CHAIN_ID ?? 5042002),
      name: "Arc Testnet",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [ARC_RPC] } },
    },
    address: USDC,
    abi: erc20Abi,
    functionName: "transfer",
    args: [params.toAddress, amount],
  });

  return { txHash: hash };
}

export function exportDepositInfo(user: User) {
  return {
    address: user.wallet_address,
    chain: "ARC-TESTNET",
    chainId: 5042002,
    usdc: USDC,
    faucet: "https://faucet.circle.com",
    note: "Request Arc Testnet USDC to this address",
  };
}
