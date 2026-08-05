/**
 * HotlineNS — human-readable payees: alice.hotline → phone → Arc wallet.
 * Registry is app-owned (DB). On-chain ArcNS can bind later; UX never speaks hex.
 */
import {
  claimHotlineName,
  getHotlineName,
  getUser,
  getUserByHotlineName,
  normalizePhone,
  releaseHotlineName,
  type User,
} from "./db.js";
import { log } from "./log.js";

const RESERVED = new Set([
  "admin",
  "hotline",
  "help",
  "support",
  "root",
  "system",
  "null",
  "undefined",
  "api",
  "www",
]);

export function normalizeHotlineLabel(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\.hotline$/i, "")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function isValidHotlineName(name: string): boolean {
  const n = normalizeHotlineLabel(name);
  if (n.length < 2 || n.length > 32) return false;
  if (!/^[a-z][a-z0-9-]*$/.test(n)) return false;
  if (RESERVED.has(n)) return false;
  return true;
}

export function displayHotline(name: string): string {
  const n = normalizeHotlineLabel(name);
  return `${n}.hotline`;
}

/** Suggest a free slug from display name (first token). */
export async function suggestHotlineName(displayName: string): Promise<string | null> {
  const base = normalizeHotlineLabel(displayName.split(/\s+/)[0] ?? "");
  if (!isValidHotlineName(base)) return null;
  if (!(await getUserByHotlineName(base))) return base;
  for (let i = 2; i <= 99; i++) {
    const cand = `${base}${i}`;
    if (cand.length > 32) break;
    if (!(await getUserByHotlineName(cand))) return cand;
  }
  return null;
}

export async function claimName(phone: string, raw: string): Promise<{ user: User; label: string }> {
  const name = normalizeHotlineLabel(raw);
  if (!isValidHotlineName(name)) {
    throw new Error("Name must be 2–32 chars, start with a letter (a-z0-9-). Try alice or bob2.");
  }
  const taken = await getHotlineName(name);
  const p = normalizePhone(phone);
  if (taken && taken.phone !== p) {
    throw new Error(`${displayHotline(name)} is taken`);
  }
  const user = await claimHotlineName(p, name);
  log.info("hotlinens claim", { phone: p, name });
  return { user, label: displayHotline(name) };
}

export async function lookupName(raw: string): Promise<{
  label: string;
  phone: string;
  displayName: string | null;
  address: string;
} | null> {
  const name = normalizeHotlineLabel(raw);
  if (!name) return null;
  const row = await getHotlineName(name);
  if (!row) return null;
  const user = await getUser(row.phone);
  if (!user) return null;
  return {
    label: displayHotline(name),
    phone: user.phone,
    displayName: user.name,
    address: user.wallet_address,
  };
}

export async function dropName(phone: string): Promise<User> {
  return releaseHotlineName(normalizePhone(phone));
}
