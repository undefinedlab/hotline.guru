#!/usr/bin/env tsx
/**
 * Terminal demo: JOIN / SEND / BALANCE without telephony.
 * Usage: npm run cli -- --phone +15551234567 JOIN alice
 */
import { loadEnv } from "../lib/env.js";
loadEnv();
import { handleMessage } from "../lib/pipeline.js";

async function main() {
  const args = process.argv.slice(2);
  let phone = process.env.HOTLINE_PHONE ?? "+15550001111";
  const phoneIdx = args.indexOf("--phone");
  if (phoneIdx >= 0) {
    phone = args[phoneIdx + 1];
    args.splice(phoneIdx, 2);
  }
  const text = args.join(" ").trim();
  if (!text) {
    console.log(`Usage: npm run cli -- [--phone +1...] <command>
Examples:
  npm run cli -- --phone +15550001 JOIN alice
  npm run cli -- --phone +15550001 PIN 1234
  npm run cli -- --phone +15550001 DEPOSIT
  npm run cli -- --phone +15550001 SEND 1 USDC TO bob
  npm run cli -- --phone +15550001 CONFIRM 1234
  npm run cli -- --phone +15550001 PRICE bitcoin`);
    process.exit(1);
  }
  const result = await handleMessage(phone, text);
  console.log(result.reply);
  if (result.data) console.log(JSON.stringify(result.data, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
