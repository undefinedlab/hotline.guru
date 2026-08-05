import { getUser, sumLedgerToday } from "./db.js";
import { limitsForTier } from "./identity.js";
import type { Intent } from "./intent.js";

export type PolicyVerdict =
  | { status: "pass" }
  | { status: "confirm"; reason: string }
  | { status: "reject"; reason: string };

/** Deterministic gate — LLM never authorizes money. Caps follow identity tier. */
export async function evaluatePolicy(phone: string, intent: Intent): Promise<PolicyVerdict> {
  const user = await getUser(phone);
  const lim = limitsForTier(user?.identity_tier ?? 0);

  if (intent.action === "price") {
    const spent = await sumLedgerToday(phone, "nanopay");
    if (spent + 0.01 > lim.nanopayDaily) {
      return { status: "reject", reason: `Nanopay daily cap $${lim.nanopayDaily} reached` };
    }
    return { status: "pass" };
  }

  if (intent.action !== "send") {
    return { status: "pass" };
  }

  const amount = intent.amount;
  if (!(amount > 0) || Number.isNaN(amount)) {
    return { status: "reject", reason: "Invalid amount" };
  }
  if (amount > lim.hardCeiling) {
    return {
      status: "reject",
      reason: `Hard ceiling: max $${lim.hardCeiling} per transfer at tier ${lim.tier} (${lim.label})`,
    };
  }
  if (amount > lim.perTx) {
    return {
      status: "confirm",
      reason: `Over soft per-tx cap $${lim.perTx} (tier ${lim.tier}) — confirm with PIN`,
    };
  }

  const sentToday = await sumLedgerToday(phone, "send");
  if (sentToday + amount > lim.daily) {
    return {
      status: "reject",
      reason: `Daily send cap $${lim.daily} would be exceeded (spent $${sentToday.toFixed(2)} today)`,
    };
  }

  return { status: "confirm", reason: "Confirm send with your PIN" };
}

export function policyLimits(tier = 0) {
  const lim = limitsForTier(tier);
  return {
    perTx: lim.perTx,
    daily: lim.daily,
    nanopayDaily: lim.nanopayDaily,
    hardCeiling: lim.hardCeiling,
    tier: lim.tier,
    label: lim.label,
  };
}
