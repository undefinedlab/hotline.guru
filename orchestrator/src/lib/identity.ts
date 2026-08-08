/**
 * Identity tiers + SIM attestation story.
 *
 * Tier 0 — phone onboarded (name + PIN)
 * Tier 1 — national ID number recorded (hashed)
 * Tier 2 — SIM-attested (telco / fraud provider); corridor caps
 *
 * Live SIM attest needs a telco partner. Lab uses SIM_ATTEST_MODE=mock|live.
 */
import { createHash } from "node:crypto";
import {
  getUser,
  setIdentityFields,
  type SimAttestStatus,
  type User,
} from "./db.js";
import { phoneFraudLookup } from "./marketplace.js";
import { log } from "./log.js";
import { isStrictProfile } from "./profile.js";

export type IdentityTier = 0 | 1 | 2;

export type TierLimits = {
  tier: IdentityTier;
  perTx: number;
  daily: number;
  hardCeiling: number;
  nanopayDaily: number;
  label: string;
};

function num(env: string, fallback: number): number {
  const v = Number(process.env[env]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Caps by identity tier — refusal is a feature. */
export function limitsForTier(tier: number): TierLimits {
  const t = Math.max(0, Math.min(2, Math.floor(tier || 0))) as IdentityTier;
  if (t === 2) {
    const perTx = num("POLICY_T2_PER_TX", num("POLICY_PER_TX_CAP", 10) * 10);
    return {
      tier: 2,
      perTx,
      daily: num("POLICY_T2_DAILY", num("POLICY_DAILY_CAP", 50) * 10),
      hardCeiling: num("POLICY_T2_HARD", perTx * 5),
      nanopayDaily: num("POLICY_NANOPAY_DAILY", 1),
      label: "SIM-attested",
    };
  }
  if (t === 1) {
    const perTx = num("POLICY_T1_PER_TX", num("POLICY_PER_TX_CAP", 10) * 2.5);
    return {
      tier: 1,
      perTx,
      daily: num("POLICY_T1_DAILY", num("POLICY_DAILY_CAP", 50) * 2),
      hardCeiling: num("POLICY_T1_HARD", perTx * 5),
      nanopayDaily: num("POLICY_NANOPAY_DAILY", 1),
      label: "ID verified",
    };
  }
  const perTx = num("POLICY_T0_PER_TX", num("POLICY_PER_TX_CAP", 10) * 0.5);
  return {
    tier: 0,
    perTx,
    daily: num("POLICY_T0_DAILY", num("POLICY_DAILY_CAP", 50) * 0.4),
    hardCeiling: num("POLICY_T0_HARD", perTx * 5),
    nanopayDaily: num("POLICY_NANOPAY_DAILY", 1),
    label: "phone-only",
  };
}

export function hashNationalId(raw: string): string {
  const cleaned = raw.replace(/\s+/g, "").toUpperCase();
  const pepper = process.env.NID_PEPPER ?? process.env.WALLET_SECRET ?? "hotline-nid-dev";
  return createHash("sha256").update(`hotline:nid:${pepper}:${cleaned}`).digest("hex");
}

export function identitySummary(user: User): string {
  const lim = limitsForTier(user.identity_tier ?? 0);
  const sim = user.sim_attest_status ?? "none";
  const ns = user.hotline_name ? `${user.hotline_name}.hotline` : "none";
  return `Tier ${lim.tier} (${lim.label}). Soft $${lim.perTx}/tx, daily $${lim.daily}, hard $${lim.hardCeiling}. SIM attest: ${sim}. HotlineNS: ${ns}.`;
}

/** Tier 1: store hashed national ID only — never plaintext. */
export async function verifyNationalId(phone: string, nationalId: string): Promise<User> {
  if (!/^[A-Za-z0-9-]{4,32}$/.test(nationalId.replace(/\s+/g, ""))) {
    throw new Error("ID should be 4–32 letters or digits");
  }
  const user = await getUser(phone);
  if (!user) throw new Error("User not found");
  const nextTier = Math.max(user.identity_tier ?? 0, 1) as IdentityTier;
  const updated = await setIdentityFields(phone, {
    national_id_hash: hashNationalId(nationalId),
    identity_tier: nextTier,
  });
  log.info("identity tier1", { phone, tier: nextTier });
  return updated;
}

/**
 * SIM attest story: telco has already KYC'd the SIM.
 * mock — lab upgrade to tier 2
 * live — optional fraud/carrier lookup; success → attested
 */
export async function attestSim(phone: string): Promise<{
  user: User;
  summary: string;
  mode: string;
}> {
  const mode = (process.env.SIM_ATTEST_MODE ?? "mock").toLowerCase();
  const user = await getUser(phone);
  if (!user) throw new Error("User not found");
  const isStrict = isStrictProfile();

  if (mode === "off" || (isStrict && mode === "mock")) {
    return {
      user,
      mode,
      summary:
        mode === "mock"
          ? "SIM mock attest disabled outside lab. Set SIM_ATTEST_MODE=live with a telco partner."
          : "SIM attest needs a telco partner. Set SIM_ATTEST_MODE=mock for lab, or live with fraud lookup.",
    };
  }

  if (mode === "live") {
    await setIdentityFields(phone, {
      sim_attest_status: "pending" as SimAttestStatus,
      sim_attest_provider: "blockrun-or-telco",
    });
    const fraud = await phoneFraudLookup(phone);
    if (!fraud.ok) {
      const failed = await setIdentityFields(phone, {
        sim_attest_status: "failed",
        sim_attest_provider: "live",
        sim_attest_at: new Date().toISOString(),
      });
      return {
        user: failed,
        mode: "live",
        summary: `SIM attest failed: ${fraud.summary}`,
      };
    }
    const attested = await setIdentityFields(phone, {
      sim_attest_status: "attested",
      sim_attest_provider: "live",
      sim_attest_at: new Date().toISOString(),
      identity_tier: 2,
    });
    log.info("sim attested live", { phone });
    return {
      user: attested,
      mode: "live",
      summary: `SIM attested. ${fraud.summary} You're tier 2, ${identitySummary(attested)}`,
    };
  }

  // mock — product story without telco API yet
  const attested = await setIdentityFields(phone, {
    sim_attest_status: "attested",
    sim_attest_provider: "mock",
    sim_attest_at: new Date().toISOString(),
    identity_tier: 2,
  });
  log.info("sim attested mock", { phone });
  return {
    user: attested,
    mode: "mock",
    summary: `SIM attest recorded (lab mock, stands in for telco SIM-KYC). ${identitySummary(attested)}`,
  };
}
