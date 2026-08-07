/**
 * Staging / prod profile guards — refuse to boot with lab secrets.
 */
import { circleConfigured } from "./circle.js";
import { log, safeEqualStr } from "./log.js";

export type HotlineProfile = "lab" | "staging" | "prod";

export function hotlineProfile(): HotlineProfile {
  const p = (process.env.HOTLINE_PROFILE ?? "lab").toLowerCase();
  if (p === "staging" || p === "prod") return p;
  return "lab";
}

export function isStrictProfile(): boolean {
  return hotlineProfile() !== "lab";
}

/**
 * Lab HTTP API (/v1/message, /v1/call/start).
 * Lab: open unless LAB_HTTP_API=0; if LAB_API_TOKEN set, require it.
 * Staging/prod: disabled unless LAB_HTTP_API=1 and LAB_API_TOKEN set.
 */
export function labHttpApiAllowed(): boolean {
  if (process.env.LAB_HTTP_API === "0") return false;
  if (isStrictProfile()) {
    return process.env.LAB_HTTP_API === "1" && Boolean(process.env.LAB_API_TOKEN);
  }
  return true;
}

export function labApiAuthorized(authHeader: string | undefined, tokenHeader: string | undefined): boolean {
  if (!labHttpApiAllowed()) return false;
  const expected = process.env.LAB_API_TOKEN;
  if (!expected) {
    // Lab without token — open (local demos). Staging never reaches here without token.
    return !isStrictProfile();
  }
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const got = bearer || tokenHeader || "";
  return Boolean(got) && safeEqualStr(got, expected);
}

/** Throws if staging/prod would run with weak/missing ops config. */
export function assertProfileConfig(): void {
  if (!isStrictProfile()) return;

  const fails: string[] = [];
  const secret = process.env.WALLET_SECRET ?? "";
  if (!secret || secret === "dev-only-change-me" || secret.length < 16) {
    fails.push("WALLET_SECRET (strong, not default)");
  }
  if (process.env.WEBHOOK_VERIFY !== "1") {
    fails.push("WEBHOOK_VERIFY=1");
  }
  if (!process.env.AUDIT_EXPORT_TOKEN) {
    fails.push("AUDIT_EXPORT_TOKEN");
  }
  if (!process.env.DATABASE_URL) {
    fails.push("DATABASE_URL (Postgres required outside lab)");
  }
  if (process.env.DEMO_SIMPLE === "1") {
    fails.push("DEMO_SIMPLE must be 0 outside lab");
  }
  const sim = (process.env.SIM_ATTEST_MODE ?? "mock").toLowerCase();
  if (sim === "mock") {
    fails.push("SIM_ATTEST_MODE=live|off (mock forbidden outside lab)");
  }
  if (process.env.LAB_HTTP_API === "1" && !process.env.LAB_API_TOKEN) {
    fails.push("LAB_API_TOKEN required when LAB_HTTP_API=1");
  }
  const sms = process.env.SMS_PROVIDER ?? "mock";
  if (sms === "telnyx") {
    if (!process.env.TELNYX_API_KEY || !process.env.TELNYX_FROM) fails.push("TELNYX_API_KEY/FROM");
    if (!process.env.TELNYX_PUBLIC_KEY && !process.env.TELNYX_WEBHOOK_SECRET) {
      fails.push("TELNYX_PUBLIC_KEY or TELNYX_WEBHOOK_SECRET");
    }
  }
  if (sms === "africas_talking") {
    if (!process.env.AT_USERNAME || !process.env.AT_API_KEY || !process.env.AT_FROM) {
      fails.push("AT_USERNAME/AT_API_KEY/AT_FROM");
    }
    if (!process.env.AT_WEBHOOK_SECRET) fails.push("AT_WEBHOOK_SECRET");
  }
  if ((process.env.WALLET_MODE ?? "circle") !== "local" && !circleConfigured()) {
    fails.push("CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET + CIRCLE_WALLET_SET_ID");
  }
  if (process.env.ALLOW_LOCAL_FALLBACK === "1") {
    fails.push("ALLOW_LOCAL_FALLBACK forbidden outside lab");
  }

  if (fails.length) {
    const msg = `HOTLINE_PROFILE=${hotlineProfile()} refused weak config: ${fails.join("; ")}`;
    log.error(msg);
    throw new Error(msg);
  }
  log.info("strict profile ok", { profile: hotlineProfile() });
}

/** Channel readiness for ops dashboards — no secrets leaked. */
export function channelStatus() {
  const sms = process.env.SMS_PROVIDER ?? "mock";
  return {
    profile: hotlineProfile(),
    webhookVerify: process.env.WEBHOOK_VERIFY === "1",
    labHttpApi: labHttpApiAllowed(),
    sms: {
      provider: sms,
      configured:
        sms === "mock" ||
        (sms === "telnyx" && Boolean(process.env.TELNYX_API_KEY && process.env.TELNYX_FROM)) ||
        (sms === "africas_talking" &&
          Boolean(process.env.AT_USERNAME && process.env.AT_API_KEY && process.env.AT_FROM)),
      verifyReady:
        sms === "mock" ||
        (sms === "telnyx" &&
          Boolean(process.env.TELNYX_PUBLIC_KEY || process.env.TELNYX_WEBHOOK_SECRET)) ||
        (sms === "africas_talking" && Boolean(process.env.AT_WEBHOOK_SECRET)),
    },
    voice: {
      didHint: process.env.INBOUND_DID ? "[set]" : null,
      trunk: process.env.SIP_TRUNK_HOST ? "[set]" : null,
      note: "Set SIP_USER/SIP_PASSWORD/SIP_TRUNK_HOST/PUBLIC_IP in .env, then npm run trunk",
    },
    whatsapp: {
      provider: process.env.WHATSAPP_PROVIDER ?? "mock",
      configured: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
    },
    telegram: {
      provider: process.env.TELEGRAM_PROVIDER ?? "mock",
      configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    },
  };
}
