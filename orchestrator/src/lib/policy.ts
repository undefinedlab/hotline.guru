import { sumLedgerToday } from "./db.js";
import type { Intent } from "./intent.js";

export type PolicyVerdict =
  | { status: "pass" }
  | { status: "confirm"; reason: string }
  | { status: "reject"; reason: string };

const PER_TX = Number(process.env.POLICY_PER_TX_CAP ?? 10);
const DAILY = Number(process.env.POLICY_DAILY_CAP ?? 50);
const NANOPAY_DAILY = Number(process.env.POLICY_NANOPAY_DAILY ?? 1);

/** Deterministic gate — LLM never authorizes money. */
export function evaluatePolicy(phone: string, intent: Intent): PolicyVerdict {
  if (intent.action === "price") {
    const spent = sumLedgerToday(phone, "nanopay");
    if (spent + 0.01 > NANOPAY_DAILY) {
      return { status: "reject", reason: `Nanopay daily cap $${NANOPAY_DAILY} reached` };
    }
    return { status: "pass" }; // auto nanopay under budget
  }

  if (intent.action !== "send") {
    return { status: "pass" };
  }

  const amount = intent.amount;
  if (!(amount > 0) || Number.isNaN(amount)) {
    return { status: "reject", reason: "Invalid amount" };
  }
  if (amount > PER_TX * 5) {
    return {
      status: "reject",
      reason: `Hard ceiling: max $${PER_TX * 5} per transfer (refused even with PIN)`,
    };
  }
  if (amount > PER_TX) {
    return {
      status: "confirm",
      reason: `Over soft per-tx cap $${PER_TX} — confirm with PIN`,
    };
  }

  const sentToday = sumLedgerToday(phone, "send");
  if (sentToday + amount > DAILY) {
    return {
      status: "reject",
      reason: `Daily send cap $${DAILY} would be exceeded (spent $${sentToday.toFixed(2)} today)`,
    };
  }

  // Always confirm money moves with PIN when user has a PIN set — handled in pipeline
  return { status: "confirm", reason: "Confirm send with your PIN" };
}

export function policyLimits() {
  return { perTx: PER_TX, daily: DAILY, nanopayDaily: NANOPAY_DAILY, hardCeiling: PER_TX * 5 };
}
