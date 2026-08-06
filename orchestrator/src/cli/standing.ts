/**
 * Run due standing orders once (cron / compose sidecar).
 * Usage: npx tsx orchestrator/src/cli/standing.ts
 */
import { loadEnv } from "../lib/env.js";
loadEnv();

import { initDb } from "../lib/db.js";
import { claimDueStanding, markStandingRan } from "../lib/retention.js";
import { handleMessage } from "../lib/pipeline.js";
import { log } from "../lib/log.js";

async function main() {
  await initDb();
  const due = await claimDueStanding();
  log.info("standing due", { count: due.length });
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
      log.info("standing ran", { id: order.id, reply: result.reply.slice(0, 80) });
    } catch (e) {
      log.error("standing failed", { id: order.id, err: String(e) });
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
