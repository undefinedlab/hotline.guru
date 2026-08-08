#!/usr/bin/env tsx
/**
 * One-time Circle entity secret registration.
 *
 *   CIRCLE_API_KEY=... npm run circle:register-secret
 *
 * Saves recovery file under ./recovery/ and appends CIRCLE_ENTITY_SECRET to .env
 * (won't overwrite an existing secret).
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadEnv } from "../lib/env.js";

loadEnv();

async function main() {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) {
    console.error("Set CIRCLE_API_KEY first (Circle Console → API keys).");
    process.exit(1);
  }

  const envPath = path.resolve(process.cwd(), ".env");
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  // .env.example ships an empty CIRCLE_ENTITY_SECRET= line — only a real value blocks.
  if (/^CIRCLE_ENTITY_SECRET=.+$/m.test(existing)) {
    console.error("CIRCLE_ENTITY_SECRET already set in .env, refusing to overwrite.");
    console.error("Rotate via Circle Console + recovery file if compromised.");
    process.exit(1);
  }

  // 32-byte hex entity secret (SDK's generateEntitySecret only prints; we persist ourselves)
  const entitySecret = randomBytes(32).toString("hex");
  const recoveryDir = path.resolve(process.cwd(), "recovery");
  fs.mkdirSync(recoveryDir, { recursive: true });

  console.log("Registering entity secret with Circle…");
  const { registerEntitySecretCiphertext } = await import(
    "@circle-fin/developer-controlled-wallets"
  );
  const response = await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
  });

  const recoveryFile = (response as { data?: { recoveryFile?: string } })?.data?.recoveryFile;
  if (recoveryFile) {
    const out = path.join(recoveryDir, `entity-secret-recovery-${Date.now()}.dat`);
    fs.writeFileSync(out, recoveryFile);
    console.log("Recovery file:", out);
  } else {
    console.warn("No recoveryFile in response, download from Circle Console if offered.");
  }

  // Fill the placeholder line in place, else append — never leave two of the same key.
  if (/^CIRCLE_ENTITY_SECRET=\s*$/m.test(existing)) {
    fs.writeFileSync(
      envPath,
      existing.replace(/^CIRCLE_ENTITY_SECRET=\s*$/m, `CIRCLE_ENTITY_SECRET=${entitySecret}`),
    );
  } else {
    fs.appendFileSync(envPath, `\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`);
  }
  console.log("Registered. CIRCLE_ENTITY_SECRET appended to .env");
  console.log("Store the recovery file separately. Never commit .env or recovery/.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
