/**
 * Run due standing orders + expire pending claims once.
 * The orchestrator does this on a timer (see lib/workers.ts); this is the
 * manual/one-shot path for cron or debugging.
 *
 * Usage: npx tsx orchestrator/src/cli/standing.ts
 */
import { loadEnv } from "../lib/env.js";
loadEnv();

import { initDb } from "../lib/db.js";
import { runWorkersOnce } from "../lib/workers.js";
import { log } from "../lib/log.js";

async function main() {
  await initDb();
  const result = await runWorkersOnce();
  log.info("workers ran once", result);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
