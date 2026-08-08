import { getUser, sumLedgerToday } from "./db.js";
import { limitsForTier } from "./identity.js";
import type { Intent } from "./intent.js";
import { applyUserRules } from "./policyRules.js";
import { availableUsdc } from "./retention.js";
import { getUsdcBalance } from "./wallets.js";
import type { Address } from "viem";

export type PolicyVerdict =
  | { status: "pass" }
  | { status: "confirm"; reason: string }
  | { status: "reject"; reason: string }
  | { status: "callback"; reason: string };

function cooldownActive(until: string | null | undefined): boolean {
  if (!until) return false;
  return Date.parse(until) > Date.now();
}

function callbackOk(until: string | null | undefined): boolean {
  if (!until) return false;
  return Date.parse(until) > Date.now();
}

function simCooldownMaxSend(): number {
  const n = Number(process.env.SIM_COOLDOWN_MAX_SEND ?? 1);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

function callbackThreshold(tier0Soft: number): number {
  const n = Number(process.env.CALLBACK_THRESHOLD_USDC ?? tier0Soft);
  return Number.isFinite(n) && n > 0 ? n : tier0Soft;
}

/** Deterministic gate — LLM never authorizes money. Caps follow identity tier + frozen user rules. */
export async function evaluatePolicy(
  phone: string,
  intent: Intent,
  opts?: { payeeLabel?: string; payeePhone?: string | null },
): Promise<PolicyVerdict> {
  const user = await getUser(phone);
  const lim = limitsForTier(user?.identity_tier ?? 0);

  if (intent.action === "price" || intent.action === "rate") {
    if (intent.action === "rate") return { status: "pass" };
    const spent = await sumLedgerToday(phone, "nanopay");
    if (spent + 0.01 > lim.nanopayDaily) {
      return { status: "reject", reason: `Nanopay daily cap $${lim.nanopayDaily} reached` };
    }
    return { status: "pass" };
  }

  if (intent.action === "swap") {
    const amount = intent.amount;
    if (!(amount > 0) || Number.isNaN(amount)) {
      return { status: "reject", reason: "Invalid swap amount" };
    }
    if (intent.tokenIn === intent.tokenOut) {
      return { status: "reject", reason: "Pick two different tokens" };
    }
    // USDC out: same spend gates as send (locks, daily, ceiling). Non-USDC: hard ceiling on units.
    if (intent.tokenIn === "USDC") {
      if (amount > lim.hardCeiling) {
        return {
          status: "reject",
          reason: `Hard ceiling: max $${lim.hardCeiling} per swap at tier ${lim.tier}`,
        };
      }
      if (cooldownActive(user?.risk_cooldown_until) && amount > simCooldownMaxSend()) {
        return {
          status: "reject",
          reason: `Risk cool-down, max $${simCooldownMaxSend()} until ${user!.risk_cooldown_until}`,
        };
      }
      if (user?.wallet_address) {
        const avail = await availableUsdc(phone, 0);
        if (avail.locked > 0) {
          const bal = await getUsdcBalance(user.wallet_address as Address, user.wallet_ref);
          const live = await availableUsdc(phone, bal);
          if (amount > live.available + 1e-9) {
            return {
              status: "reject",
              reason: `Savings lock: $${live.locked.toFixed(2)} locked, available $${live.available.toFixed(2)}`,
            };
          }
        }
      }
      const sentToday = await sumLedgerToday(phone, "send");
      const escrowToday = await sumLedgerToday(phone, "escrow_hold");
      const swapToday = await sumLedgerToday(phone, "swap");
      if (sentToday + escrowToday + swapToday + amount > lim.daily) {
        return {
          status: "reject",
          reason: `Daily spend cap $${lim.daily} would be exceeded`,
        };
      }
    } else if (amount > lim.hardCeiling) {
      return {
        status: "reject",
        reason: `Hard ceiling: max ${lim.hardCeiling} ${intent.tokenIn} per swap at tier ${lim.tier}`,
      };
    }
    return { status: "confirm", reason: "Confirm swap with your PIN" };
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

  // Frozen spoken rules — only tighten (before callback so the leash is visible)
  if (opts?.payeeLabel) {
    const ur = await applyUserRules({
      phone,
      amount,
      payeeLabel: opts.payeeLabel,
      payeePhone: opts.payeePhone,
    });
    if (!ur.ok) return { status: "reject", reason: ur.reason };
  }

  // SIM-swap / risk cool-down — high-value blocked until window ends
  if (cooldownActive(user?.risk_cooldown_until) && amount > simCooldownMaxSend()) {
    return {
      status: "reject",
      reason: `Risk cool-down active after SIM/port signal, max $${simCooldownMaxSend()} until ${user!.risk_cooldown_until}`,
    };
  }

  // Caller ID is a claim: above threshold requires recent outbound callback verify
  const needCb = amount > callbackThreshold(lim.perTx);
  if (needCb && !callbackOk(user?.callback_verified_until)) {
    return {
      status: "callback",
      reason: `Amount over $${callbackThreshold(lim.perTx)} needs outbound callback, say CALLBACK then confirm when we call the number of record`,
    };
  }

  // Savings lock — only when funds are locked
  if (user?.wallet_address) {
    const avail = await availableUsdc(phone, 0);
    if (avail.locked > 0) {
      const bal = await getUsdcBalance(user.wallet_address as Address, user.wallet_ref);
      const live = await availableUsdc(phone, bal);
      if (amount > live.available + 1e-9) {
        return {
          status: "reject",
          reason: `Savings lock: $${live.locked.toFixed(2)} locked until maturity, available $${live.available.toFixed(2)}`,
        };
      }
    }
  }

  if (amount > lim.perTx) {
    return {
      status: "confirm",
      reason: `Over soft per-tx cap $${lim.perTx} (tier ${lim.tier}), confirm with PIN`,
    };
  }

  const sentToday = await sumLedgerToday(phone, "send");
  const escrowToday = await sumLedgerToday(phone, "escrow_hold");
  if (sentToday + escrowToday + amount > lim.daily) {
    return {
      status: "reject",
      reason: `Daily send cap $${lim.daily} would be exceeded (spent $${(sentToday + escrowToday).toFixed(2)} today)`,
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
