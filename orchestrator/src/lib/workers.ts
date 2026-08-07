/**
 * Scheduled jobs: standing orders + pending-claim expiry.
 *
 * Runs on a timer inside the orchestrator process — no cron container and no
 * new dependency. Set WORKERS_INTERVAL_MIN=0 to disable, which you want if you
 * ever run more than one orchestrator (both would fire the same jobs).
 *
 * Lives here rather than in retention.ts because it needs handleMessage, and
 * pipeline.ts already imports retention.ts — importing back would be a cycle.
 */
import { expirePendingClaims } from "./claims.js";
import { claimDueStanding, markStandingRan } from "./retention.js";
import { handleMessage } from "./pipeline.js";
import { log } from "./log.js";

/** Milliseconds between runs; 0 means disabled. */
export function workerIntervalMs(raw = process.env.WORKERS_INTERVAL_MIN): number {
  const min = Number(raw ?? 15);
  return Number.isFinite(min) && min > 0 ? min * 60_000 : 0;
}

/** Execute every standing order that is due. Returns how many ran. */
export async function runDueStanding(): Promise<number> {
  const due = await claimDueStanding();
  if (due.length) log.info("standing due", { count: due.length });
  let ran = 0;
  for (const order of due) {
    const target = order.to_phone ?? order.to_label;
    const text = `send ${order.amount_usdc} usdt to ${target}`;
    const idem = `stand:${order.id}:${order.next_run_at.slice(0, 10)}`;
    try {
      let result = await handleMessage(order.phone, text);
      if (result.needsPin) {
        const pin = process.env.STANDING_PIN ?? process.env.DEMO_PIN ?? "";
        if (!pin) {
          log.warn("standing needs PIN — set STANDING_PIN or run interactively", {
            id: order.id,
          });
          continue;
        }
        result = await handleMessage(order.phone, `CONFIRM ${pin}`);
      }
      await markStandingRan(order, idem);
      ran++;
      log.info("standing ran", { id: order.id, reply: result.reply.slice(0, 80) });
    } catch (e) {
      log.error("standing failed", { id: order.id, err: String(e) });
    }
  }
  return ran;
}

export async function runWorkersOnce(): Promise<{ standing: number; expired: number }> {
  const standing = await runDueStanding();
  const expired = await expirePendingClaims();
  if (expired) log.info("pending claims expired", { count: expired });
  return { standing, expired };
}

let running = false;

/** Start the timer. Safe to call once at boot; no-op when disabled. */
export function startWorkers(): void {
  const every = workerIntervalMs();
  if (!every) {
    log.info("workers disabled", { reason: "WORKERS_INTERVAL_MIN<=0" });
    return;
  }
  const tick = async () => {
    // These move money — never let a slow run overlap the next tick.
    if (running) return;
    running = true;
    try {
      await runWorkersOnce();
    } catch (e) {
      log.error("worker tick failed", { err: String(e) });
    } finally {
      running = false;
    }
  };
  // unref so a pending timer never holds the process open on shutdown.
  setInterval(tick, every).unref();
  log.info("workers started", { everyMinutes: every / 60_000 });
  void tick(); // catch up on anything that fell due while we were down
}
