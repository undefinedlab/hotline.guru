/**
 * Standing orders + savings locks — scheduler-friendly, policy-gated execution.
 */
import { bumpStandingOrder, createSavingsLock, createStandingOrder, listDueStandingOrders, listSavingsLocks, listStandingOrders, releaseMaturedLocks, sumActiveSavingsLocked, type StandingOrder } from "./db.js";
import { log } from "./log.js";

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

export function parseUnlockDate(raw: string): Date | null {
  const t = raw.trim().toLowerCase();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const month = MONTHS[t];
  if (month != null) {
    const now = new Date();
    let y = now.getUTCFullYear();
    if (month < now.getUTCMonth() || (month === now.getUTCMonth() && now.getUTCDate() > 1)) {
      y += 1;
    }
    return new Date(Date.UTC(y, month, 1));
  }
  return null;
}

export function nextStandingRun(cadence: string, from = new Date()): Date {
  const d = new Date(from.getTime());
  if (cadence === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7);
    return d;
  }
  // monthly — first of next month
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function firstOfNextMonth(from = new Date()): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  return d;
}

export async function openStandingOrder(input: {
  phone: string;
  amount: number;
  toLabel: string;
  toPhone?: string | null;
  toAddress?: string | null;
  cadence: "monthly" | "weekly";
}) {
  const next =
    input.cadence === "monthly" ? firstOfNextMonth() : nextStandingRun("weekly");
  return createStandingOrder({
    phone: input.phone,
    amount_usdc: input.amount,
    to_label: input.toLabel,
    to_phone: input.toPhone ?? null,
    to_address: input.toAddress ?? null,
    cadence: input.cadence,
    next_run_at: next.toISOString(),
  });
}

export async function availableUsdc(phone: string, balance: number): Promise<{
  balance: number;
  locked: number;
  available: number;
}> {
  const now = new Date().toISOString();
  await releaseMaturedLocks(phone, now);
  const locked = await sumActiveSavingsLocked(phone, now);
  return {
    balance,
    locked,
    available: Math.max(0, balance - locked),
  };
}

export async function lockSavings(phone: string, amount: number, unlockAt: Date) {
  return createSavingsLock({
    phone,
    amount_usdc: amount,
    unlock_at: unlockAt.toISOString(),
  });
}

export { listStandingOrders, listSavingsLocks };

/** Advance due standing rows — caller executes the actual send. */
export async function claimDueStanding(): Promise<StandingOrder[]> {
  return listDueStandingOrders(new Date().toISOString());
}

export async function markStandingRan(order: StandingOrder, idemKey: string): Promise<void> {
  const next = nextStandingRun(order.cadence === "weekly" ? "weekly" : "monthly");
  await bumpStandingOrder(order.id, next.toISOString(), idemKey);
  log.info("standing bumped", { id: order.id, next: next.toISOString() });
}
