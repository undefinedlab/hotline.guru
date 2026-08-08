/**
 * Persistent lab treasury + sink EOAs we fully control (recycle demo USDC).
 * Circle agent funds the treasury; demos send dust back to the sink (= treasury).
 */
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
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

const USDC = (process.env.USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000") as Address;
const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? 5042002);
const STORE = path.resolve(process.cwd(), process.env.LAB_WALLETS_PATH ?? "./data/lab-wallets.json");

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address" },
      { type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const chain = {
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

export type LabWallets = {
  treasury: { address: Address; encPk: string };
  /** Alias — same as treasury so demo pays recycle home */
  sinkPhone: string;
};

function secretKey(): Buffer {
  return scryptSync(process.env.WALLET_SECRET ?? "dev-only-change-me", "hotline.guru", 32);
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

export function loadOrCreateLabWallets(): LabWallets {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  if (fs.existsSync(STORE)) {
    return JSON.parse(fs.readFileSync(STORE, "utf8")) as LabWallets;
  }
  const pk = `0x${randomBytes(32).toString("hex")}` as Hex;
  const account = privateKeyToAccount(pk);
  const lab: LabWallets = {
    treasury: { address: account.address, encPk: encryptPk(pk) },
    sinkPhone: "+15550000999",
  };
  fs.writeFileSync(STORE, JSON.stringify(lab, null, 2));
  console.log(`[lab] created treasury ${lab.treasury.address}`);
  return lab;
}

export function treasuryAccount() {
  const lab = loadOrCreateLabWallets();
  return privateKeyToAccount(decryptPk(lab.treasury.encPk));
}

export async function getUsdcBalance(address: Address): Promise<number> {
  const client = createPublicClient({ transport: http(RPC) });
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      const raw = await client.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      });
      return Number(formatUnits(raw, 6));
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

export async function transferFromTreasury(to: Address, amountUsdc: number): Promise<Hex> {
  const account = treasuryAccount();
  const wallet = createWalletClient({ account, transport: http(RPC) });
  return wallet.writeContract({
    chain,
    address: USDC,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, parseUnits(amountUsdc.toFixed(6), 6)],
  });
}

/** Sweep local EOA → treasury (recycle). */
export async function transferToTreasury(fromEncPk: string, amountUsdc: number): Promise<Hex> {
  const lab = loadOrCreateLabWallets();
  const account = privateKeyToAccount(decryptPk(fromEncPk));
  const wallet = createWalletClient({ account, transport: http(RPC) });
  return wallet.writeContract({
    chain,
    address: USDC,
    abi: erc20Abi,
    functionName: "transfer",
    args: [lab.treasury.address, parseUnits(amountUsdc.toFixed(6), 6)],
  });
}

/** Request Arc Testnet USDC via Circle faucet API (needs CIRCLE_API_KEY). */
export async function requestFaucet(address: string): Promise<{ ok: boolean; detail: string }> {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      detail:
        "No CIRCLE_API_KEY, open https://faucet.circle.com (Arc Testnet) or set CIRCLE_API_KEY for auto-drip",
    };
  }
  const res = await fetch("https://api.circle.com/v1/faucet/drips", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Request-Id": crypto.randomUUID(),
    },
    body: JSON.stringify({
      address,
      blockchain: "ARC-TESTNET",
      usdc: true,
    }),
  });
  if (res.status === 204 || res.ok) {
    return { ok: true, detail: `faucet drip accepted for ${address}` };
  }
  const body = await res.text();
  return { ok: false, detail: `faucet ${res.status}: ${body}` };
}
