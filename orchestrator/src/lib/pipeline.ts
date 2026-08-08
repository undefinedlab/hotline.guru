import { createHash, randomInt, randomUUID } from "node:crypto";
import { isAddress, type Address } from "viem";
import {
  addLedger,
  cancelStandingOrder,
  claimIdempotency,
  clearPinFailures,
  clearRecoveryChallenge,
  getPending,
  getUser,
  isPinLocked,
  listContacts,
  listLedger,
  normalizePhone,
  recordPinFailure,
  recordPolicyDecision,
  saveContact,
  saveIdempotentResult,
  setCallbackVerified,
  setPending,
  setPin,
  setRecoveryChallenge,
  setRiskCooldown,
  setUserName,
  type User,
} from "./db.js";
import { resolvePayee } from "./contacts.js";
import { fulfillPendingClaimsFor, holdPendingClaim, pendingClaimDays } from "./claims.js";
import { claimName, lookupName, normalizeHotlineLabel, suggestHotlineName } from "./hotlinens.js";
import { formatSpokenUsdc } from "./moneyFormat.js";
import { attestSim, identitySummary, verifyNationalId } from "./identity.js";
import { parseIntentSmart, parseNameAnswer, type Intent } from "./intent.js";
import { evaluatePolicy } from "./policy.js";
import {
  clearFrozenRules,
  compilePolicySmart,
  describeRules,
  freezeRules,
  loadFrozenRules,
  type FrozenRule,
} from "./policyRules.js";
import {
  availableUsdc,
  listSavingsLocks,
  listStandingOrders,
  lockSavings,
  openStandingOrder,
  parseUnlockDate,
} from "./retention.js";
import { fetchCryptoPrice, phoneFraudLookup } from "./marketplace.js";
import { createSmsProvider } from "./sms.js";
import { canReceiveSms } from "./channel.js";
import {
  ensureWallet,
  exportDepositInfo,
  getUsdcBalance,
  hashPin,
  transferUsdc,
  verifyPin,
} from "./wallets.js";
import { estimateArcSwap, executeArcSwap, getTokenBalance } from "./swap.js";
import { spokenToken, type SwapToken } from "./tokens.js";
import { buildAirtimeQuote, fulfillAirtime } from "./airtime.js";
import { log, shortHash } from "./log.js";
import {
  cartCheckoutUrl,
  enrichCircleProduct,
  shopSearch,
  shopSkillUrl,
  type ShopProduct,
} from "./shop.js";

const sms = createSmsProvider();

function demoSimple(): boolean {
  return process.env.DEMO_SIMPLE === "1";
}

function demoPin(): string {
  return process.env.DEMO_PIN ?? "1234";
}

function pinMaxFails(): number {
  return Number(process.env.PIN_MAX_FAILS ?? 5);
}

function pinLockMinutes(): number {
  return Number(process.env.PIN_LOCK_MINUTES ?? 15);
}

export type HandleResult = {
  reply: string;
  /** Shorter line for TTS — no tx hashes / URLs. Falls back to reply. */
  spoken?: string;
  data?: Record<string, unknown>;
  needsName?: boolean;
  needsPin?: boolean;
  needsSetPin?: boolean;
  needsMemo?: boolean;
  onboarding?: boolean;
  guest?: boolean;
};

type PendingSend = {
  type: "send";
  amount: number;
  toLabel: string;
  toAddress: Address | null;
  toPhone?: string;
  provisioned?: boolean;
  pendingClaim?: boolean;
  idemKey?: string;
  memoText?: string;
};

type PendingSwap = {
  type: "swap";
  amount: number;
  tokenIn: SwapToken;
  tokenOut: SwapToken;
  estimatedOut?: string;
  idemKey?: string;
};

type PendingTopup = {
  type: "topup";
  faceAmount: number;
  faceCurrency: "EUR" | "USD";
  chargeUsdc: number;
  msisdn: string;
  productLabel: string;
  idemKey?: string;
};

type PendingName = { type: "awaiting_name" };
type PendingPolicy = { type: "awaiting_policy_confirm"; rules: FrozenRule[] };
type PendingStanding = {
  type: "awaiting_standing_confirm";
  amount: number;
  toLabel: string;
  toPhone?: string;
  toAddress?: string | null;
  cadence: "monthly" | "weekly";
};
type PendingLock = {
  type: "awaiting_lock_confirm";
  amount: number;
  unlockAt: string;
};
type PendingShop = {
  type: "shop_results";
  products: ShopProduct[];
};

type AnyPending =
  | PendingName
  | PendingSend
  | PendingSwap
  | PendingTopup
  | PendingPolicy
  | PendingStanding
  | PendingLock
  | PendingShop;

function firstName(user: User | null | undefined): string | null {
  const n = user?.name?.trim();
  return n ? n.split(/\s+/)[0]! : null;
}

function withName(user: User | null | undefined, body: string): string {
  const n = firstName(user);
  return n ? `Hey ${n}. ${body}` : body;
}

function isOnboarded(user: User): boolean {
  if (!user.name) return false;
  if (demoSimple()) return true;
  return !!user.pin_hash;
}

/**
 * Chat users reply with just the digits — "3973" — because we asked for a PIN.
 * Voice never hits this: the AGI collects DTMF and sends "PIN 3973" itself.
 * Without this, bare digits match no intent and the caller loops on the prompt.
 */
async function expandBarePin(phone: string, text: string): Promise<string> {
  const digits = text.trim();
  if (!/^\d{4,6}$/.test(digits)) return text;
  const pending = await getPending<AnyPending>(phone);
  // A name prompt is the one place digits are not a PIN.
  if (pending && pending.type !== "awaiting_name") return `CONFIRM ${digits}`;
  if (pending) return text;
  const user = await getUser(phone);
  if (user && !isOnboarded(user)) return `PIN ${digits}`;
  return text;
}

export async function handleMessage(phoneRaw: string, text: string): Promise<HandleResult> {
  const phone = normalizePhone(phoneRaw);
  const effective = await expandBarePin(phone, text);
  const intent = await parseIntentSmart(effective);
  return dispatch(phone, intent, effective);
}

export async function handleCallStart(phoneRaw: string): Promise<HandleResult> {
  const phone = normalizePhone(phoneRaw);
  const user = await ensureCaller(phone);
  return continueOnboardOrGreet(phone, user);
}

/** Missed call / flash — balance by SMS, zero cost to user. */
export async function handleMissedCall(phoneRaw: string): Promise<HandleResult> {
  const phone = normalizePhone(phoneRaw);
  const user = await getUser(phone);
  if (!user?.wallet_address || !isOnboarded(user)) {
    const reply =
      "hotline.guru: flash received. Call back and say your name to open your number, then flash again for balance.";
    if (canReceiveSms(phone)) void sms.send(phone, reply).catch(() => {});
    return { reply, guest: true, data: { flash: true, onboarded: false } };
  }
  const bal = await getUsdcBalance(user.wallet_address as Address, user.wallet_ref);
  const avail = await availableUsdc(phone, bal);
  const reply = `hotline.guru: balance ${formatSpokenUsdc(avail.balance)} (${formatSpokenUsdc(avail.available)} available${avail.locked ? `, ${formatSpokenUsdc(avail.locked)} locked` : ""}).`;
  if (canReceiveSms(phone)) void sms.send(phone, reply).catch(() => {});
  return { reply, data: { flash: true, ...avail } };
}

/** Dial-a-rate — free reference rate, no account. */
export async function handleDialRate(phoneRaw?: string): Promise<HandleResult> {
  const phone = phoneRaw ? normalizePhone(phoneRaw) : "guest:rate";
  const price = await fetchCryptoPrice("usd-coin", phone);
  const reply = price.ok
    ? `Reference: ${price.summary}. Free rate check, no account needed. Open an account to send.`
    : `Rate lookup busy. Try again shortly.`;
  return { reply, guest: true, data: { mode: price.mode, rate: true } };
}

async function ensureCaller(phone: string) {
  let user = await getUser(phone);
  if (!user) {
    user = await ensureWallet(phone);
  }
  if (demoSimple() && !user.pin_hash) {
    await setPin(phone, hashPin(demoPin()));
    user = (await getUser(phone))!;
  }
  return user;
}

async function continueOnboardOrGreet(phone: string, user: User): Promise<HandleResult> {
  if (!user.name) {
    await setPending(phone, { type: "awaiting_name" } satisfies PendingName);
    return {
      reply:
        "Welcome to hotline.guru. We'll set up your account on this number. What's your first name?",
      needsName: true,
      onboarding: true,
      data: { onboard: true, address: user.wallet_address },
    };
  }

  if (!isOnboarded(user)) {
    return {
      reply: `Welcome back, ${firstName(user)}. Finish setup: choose a 4-digit PIN.`,
      needsSetPin: true,
      onboarding: true,
      data: { onboard: true, name: user.name, address: user.wallet_address },
    };
  }

  await setPending(phone, null);
  return {
    reply: `Hey ${firstName(user)}, what can I do for you?`,
    data: { name: user.name, address: user.wallet_address },
  };
}

async function finishNaming(phone: string, rawName: string): Promise<HandleResult> {
  await ensureCaller(phone);
  const user = await setUserName(phone, rawName);
  const dep = exportDepositInfo(user);
  const suggest = await suggestHotlineName(user.name ?? rawName);
  const nsHint = suggest ? ` Claim ${suggest}.hotline anytime with CLAIM ${suggest}.` : "";

  if (demoSimple()) {
    if (!user.pin_hash) await setPin(phone, hashPin(demoPin()));
    await setPending(phone, null);
    return {
      reply: `Nice to meet you, ${firstName(user)}. You're set.${nsHint} What can I do for you?`,
      data: { name: user.name, address: dep.address, suggestHotline: suggest },
    };
  }

  await setPending(phone, null);
  return {
    reply: `Nice to meet you, ${firstName(user)}. Your Arc wallet is ready.${nsHint} Choose a 4-digit PIN.`,
    needsSetPin: true,
    onboarding: true,
    data: { name: user.name, address: dep.address, onboard: true, suggestHotline: suggest },
  };
}

async function completePinSetup(phone: string, pin: string): Promise<HandleResult> {
  await ensureCaller(phone);
  await setPin(phone, hashPin(pin));
  const fresh = (await getUser(phone))!;
  const dep = exportDepositInfo(fresh);
  await setPending(phone, null);

  const reply = fresh.name
    ? `Thanks, ${firstName(fresh)}. You're all set on this number. You can now send USDC to any phone number.`
    : "PIN set. You're ready.";

  const claimed = await fulfillPendingClaimsFor(phone);
  const claimNote =
    claimed > 0
      ? ` ${claimed} pending transfer(s) were released to your wallet.`
      : "";

  void (canReceiveSms(phone)
    ? sms
        .send(
          phone,
          `hotline.guru: hi ${firstName(fresh) ?? "there"}. Deposit Arc USDC to ${dep.address}`,
        )
        .catch(() => {})
    : undefined);

  return {
    reply: `${reply}${claimNote}`,
    onboarding: false,
    data: { name: fresh.name, address: dep.address, onboarded: true, claimsFulfilled: claimed },
  };
}

async function dispatch(phone: string, intent: Intent, raw: string): Promise<HandleResult> {
  const awaiting = await getPending<AnyPending>(phone);

  if (awaiting?.type === "awaiting_name") {
    if (intent.action === "set_name") return finishNaming(phone, intent.name);
    const bare = parseNameAnswer(raw);
    if (bare) return finishNaming(phone, bare);
    return {
      reply: "Just tell me your first name, for example Ben.",
      needsName: true,
      onboarding: true,
    };
  }

  // Free dial-a-rate before onboard gate
  if (intent.action === "rate") {
    return handleDialRate(phone);
  }

  if (intent.action === "set_name") {
    await ensureCaller(phone);
    return finishNaming(phone, intent.name);
  }

  if (intent.action === "hello") {
    const user = await ensureCaller(phone);
    return continueOnboardOrGreet(phone, user);
  }

  if (intent.action === "set_pin") {
    const user = await ensureCaller(phone);
    if (!user.name && !demoSimple()) {
      await setPending(phone, { type: "awaiting_name" });
      return {
        reply: "First tell me your name, then we'll set your PIN.",
        needsName: true,
        onboarding: true,
      };
    }
    if (user.pin_hash && isOnboarded(user) && !demoSimple()) {
      return {
        reply: withName(
          user,
          "PIN already set. Change with CHANGE PIN <old> <new>, or RECOVER PIN if you forgot (callback + cool-down).",
        ),
      };
    }
    return completePinSetup(phone, intent.pin);
  }

  if (intent.action === "change_pin") {
    const user = await ensureCaller(phone);
    if (!user.pin_hash || !verifyPin(user, intent.oldPin)) {
      return { reply: withName(user, "Old PIN incorrect.") };
    }
    await setPin(phone, hashPin(intent.newPin));
    await clearPinFailures(phone);
    return { reply: withName(user, "PIN updated.") };
  }

  if (intent.action === "recover_pin") {
    const user = await ensureCaller(phone);
    if (!user.pin_hash) {
      return { reply: withName(user, "No PIN yet, finish onboarding first.") };
    }
    const code = String(randomInt(100000, 999999));
    const hash = createHash("sha256").update(`hotline:recover:${phone}:${code}`).digest("hex");
    const expires = new Date(Date.now() + 15 * 60_000).toISOString();
    await setRecoveryChallenge(phone, hash, expires);
    log.info("recovery outbound callback stub", { phone });
    if (canReceiveSms(phone)) {
      void sms.send(phone, `hotline.guru recovery code: ${code}. Reply RECOVER CONFIRM ${code} <newpin>`).catch(() => {});
    }
    return {
      reply: withName(
        user,
        `Recovery started. We'll call/SMS the number of record with a code. Then say RECOVER CONFIRM <code> <newpin>. High-value sends cool down after reset.`,
      ),
      data: { recovery: true, ...(demoSimple() ? { labCode: code } : {}) },
    };
  }

  if (intent.action === "recover_confirm") {
    const user = await ensureCaller(phone);
    if (!user.recovery_code_hash || !user.recovery_expires_at) {
      return { reply: withName(user, "No recovery in progress. Say RECOVER PIN first.") };
    }
    if (Date.parse(user.recovery_expires_at) < Date.now()) {
      await clearRecoveryChallenge(phone);
      return { reply: withName(user, "Recovery code expired. Say RECOVER PIN again.") };
    }
    const expect = createHash("sha256")
      .update(`hotline:recover:${phone}:${intent.code}`)
      .digest("hex");
    if (expect !== user.recovery_code_hash) {
      return { reply: withName(user, "Recovery code incorrect.") };
    }
    await setPin(phone, hashPin(intent.pin));
    await clearRecoveryChallenge(phone);
    await clearPinFailures(phone);
    const hours = Number(process.env.SIM_COOLDOWN_HOURS ?? 24);
    await setRiskCooldown(phone, new Date(Date.now() + hours * 3600_000).toISOString());
    return {
      reply: withName(
        user,
        `PIN reset. Risk cool-down ${hours}h on larger sends (SIM-swap / recovery protection).`,
      ),
    };
  }

  if (intent.action === "report_sim") {
    const user = await ensureCaller(phone);
    const hours = Number(process.env.SIM_COOLDOWN_HOURS ?? 24);
    await setRiskCooldown(phone, new Date(Date.now() + hours * 3600_000).toISOString());
    return {
      reply: withName(
        user,
        `SIM/port signal recorded. High-value sends limited for ${hours}h. Telco partners can feed this automatically.`,
      ),
    };
  }

  if (intent.action === "callback") {
    const user = await ensureCaller(phone);
    log.info("outbound callback verify stub", { phone });
    const mins = Number(process.env.CALLBACK_VERIFY_MINUTES ?? 20);
    await setCallbackVerified(phone, new Date(Date.now() + mins * 60_000).toISOString());
    if (canReceiveSms(phone)) {
      void sms.send(phone, `hotline.guru: callback verify OK for ${mins} minutes.`).catch(() => {});
    }
    return {
      reply: withName(
        user,
        `Outbound verify noted for this number (lab stub). You can confirm larger sends for ${mins} minutes. Production places a real callback.`,
      ),
    };
  }

  if (intent.action === "cancel") {
    const pending = await getPending<AnyPending>(phone);
    if (pending && "type" in pending && pending.type === "awaiting_name") {
      return {
        reply: "Still need your name to finish setup. What's your first name?",
        needsName: true,
        onboarding: true,
      };
    }
    await setPending(phone, null);
    return { reply: withName(await getUser(phone), "Cancelled.") };
  }

  if (intent.action === "confirm" || intent.action === "confirm_policy") {
    const pending = await getPending<AnyPending>(phone);
    const user = await ensureCaller(phone);

    if (pending?.type === "awaiting_policy_confirm") {
      if (!isOnboarded(user)) return continueOnboardOrGreet(phone, user);
      if (isPinLocked(user)) {
        return {
          reply: withName(user, `PIN locked. Try again after ${user.pin_locked_until}.`),
        };
      }
      const pin =
        (intent.action === "confirm_policy" ? intent.pin : undefined) ??
        (intent.action === "confirm" ? intent.pin : undefined) ??
        (demoSimple() ? demoPin() : undefined);
      if (!pin) {
        return {
          reply: `Confirm your rule: ${describeRules(pending.rules)} Enter PIN to freeze it.`,
          needsPin: true,
        };
      }
      if (!verifyPin(user, pin)) {
        await recordPinFailure(phone, pinMaxFails(), pinLockMinutes());
        return { reply: "Wrong PIN. Try again.", needsPin: true };
      }
      await clearPinFailures(phone);
      await clearFrozenRules(phone);
      await freezeRules(phone, pending.rules);
      await setPending(phone, null);
      await recordPolicyDecision({
        phone,
        action: "set_policy",
        verdict: "pass",
        reason: describeRules(pending.rules),
        intent: { action: "set_policy", spoken: pending.rules[0]?.spoken ?? "" },
      });
      return {
        reply: withName(
          user,
          `Frozen. ${describeRules(pending.rules)} The model can't loosen this, only you can CLEAR POLICY.`,
        ),
        data: { rules: pending.rules },
      };
    }

    if (pending?.type === "awaiting_standing_confirm") {
      const pin = intent.action === "confirm" ? intent.pin : undefined;
      const usePin = pin ?? (demoSimple() ? demoPin() : undefined);
      if (!usePin) {
        return {
          reply: `Confirm standing ${pending.amount} USDC to ${pending.toLabel} ${pending.cadence}? Enter PIN.`,
          needsPin: true,
        };
      }
      if (!verifyPin(user, usePin)) {
        await recordPinFailure(phone, pinMaxFails(), pinLockMinutes());
        return { reply: "Wrong PIN. Try again.", needsPin: true };
      }
      await clearPinFailures(phone);
      const order = await openStandingOrder({
        phone,
        amount: pending.amount,
        toLabel: pending.toLabel,
        toPhone: pending.toPhone,
        toAddress: pending.toAddress,
        cadence: pending.cadence,
      });
      await setPending(phone, null);
      return {
        reply: withName(
          user,
          `Standing order #${order.id}: ${pending.amount} USDC to ${pending.toLabel} ${pending.cadence}, next ${order.next_run_at.slice(0, 10)}.`,
        ),
        data: { standingId: order.id },
      };
    }

    if (pending?.type === "awaiting_lock_confirm") {
      const pin = intent.action === "confirm" ? intent.pin : undefined;
      const usePin = pin ?? (demoSimple() ? demoPin() : undefined);
      if (!usePin) {
        return {
          reply: `Lock $${pending.amount} until ${pending.unlockAt.slice(0, 10)}? Enter PIN.`,
          needsPin: true,
        };
      }
      if (!verifyPin(user, usePin)) {
        await recordPinFailure(phone, pinMaxFails(), pinLockMinutes());
        return { reply: "Wrong PIN. Try again.", needsPin: true };
      }
      await clearPinFailures(phone);
      const lock = await lockSavings(phone, pending.amount, new Date(pending.unlockAt));
      await setPending(phone, null);
      await addLedger({
        phone,
        kind: "savings_lock",
        amount_usdc: pending.amount,
        meta: JSON.stringify({ unlock_at: pending.unlockAt, id: lock.id }),
      });
      return {
        reply: withName(
          user,
          `Locked $${pending.amount} until ${pending.unlockAt.slice(0, 10)}. That slice won't send until then.`,
        ),
        data: { lockId: lock.id },
      };
    }

    if (pending?.type === "swap") {
      if (!isOnboarded(user)) {
        return continueOnboardOrGreet(phone, user);
      }
      if (isPinLocked(user)) {
        return {
          reply: withName(
            user,
            `PIN locked after too many tries. Try again after ${user.pin_locked_until}.`,
          ),
        };
      }
      const pin =
        (intent.action === "confirm" ? intent.pin : undefined) ??
        (demoSimple() ? demoPin() : undefined);
      if (!pin) {
        return {
          reply: "Send your PIN to confirm.",
          needsPin: true,
        };
      }
      if (!verifyPin(user, pin)) {
        const updated = await recordPinFailure(phone, pinMaxFails(), pinLockMinutes());
        if (isPinLocked(updated)) {
          await setPending(phone, null);
          return {
            reply: withName(updated, "Too many wrong PINs. Swap cancelled. PIN locked for a while."),
          };
        }
        return { reply: "Wrong PIN. Try again.", needsPin: true };
      }
      await clearPinFailures(phone);
      return executeSwap(phone, pending, user);
    }

    if (pending?.type === "topup") {
      if (!isOnboarded(user)) {
        return continueOnboardOrGreet(phone, user);
      }
      if (isPinLocked(user)) {
        return {
          reply: withName(
            user,
            `PIN locked after too many tries. Try again after ${user.pin_locked_until}.`,
          ),
        };
      }
      const pin =
        (intent.action === "confirm" ? intent.pin : undefined) ??
        (demoSimple() ? demoPin() : undefined);
      if (!pin) {
        return {
          reply: "Enter your PIN on the keypad, or say yes and your PIN.",
          needsPin: true,
        };
      }
      if (!verifyPin(user, pin)) {
        const updated = await recordPinFailure(phone, pinMaxFails(), pinLockMinutes());
        if (isPinLocked(updated)) {
          await setPending(phone, null);
          return {
            reply: withName(updated, "Too many wrong PINs. Top-up cancelled. PIN locked for a while."),
          };
        }
        return { reply: "Wrong PIN. Try again.", needsPin: true };
      }
      await clearPinFailures(phone);
      return executeTopup(phone, pending, user);
    }

    if (!pending || pending.type !== "send") {
      return { reply: "Nothing pending to confirm." };
    }
    if (!isOnboarded(user)) {
      return continueOnboardOrGreet(phone, user);
    }
    if (isPinLocked(user)) {
      return {
        reply: withName(
          user,
          `PIN locked after too many tries. Try again after ${user.pin_locked_until}.`,
        ),
      };
    }
    const pin = (intent.action === "confirm" ? intent.pin : undefined) ?? (demoSimple() ? demoPin() : undefined);
    if (!pin) {
      return {
        reply: "Send your PIN to confirm.",
        needsPin: true,
      };
    }
    if (!verifyPin(user, pin)) {
      const updated = await recordPinFailure(phone, pinMaxFails(), pinLockMinutes());
      log.warn("pin failure", {
        phone,
        fails: updated.pin_fail_count,
        locked: isPinLocked(updated),
      });
      if (isPinLocked(updated)) {
        await setPending(phone, null);
        return {
          reply: withName(updated, "Too many wrong PINs. Send cancelled. PIN locked for a while."),
        };
      }
      return { reply: "Wrong PIN. Try again.", needsPin: true };
    }
    await clearPinFailures(phone);
    return executeSend(phone, pending, user);
  }

  if (intent.action === "join") {
    await ensureWallet(phone, intent.name);
    let fraudNote = "";
    if (process.env.FRAUD_CHECK_ON_JOIN === "1") {
      const fraud = await phoneFraudLookup(phone);
      fraudNote = ` ${fraud.summary}.`;
    }
    if (intent.name) {
      const named = await finishNaming(phone, intent.name);
      if (fraudNote) named.reply = `${named.reply}${fraudNote}`;
      return named;
    }
    const fresh = (await getUser(phone))!;
    return continueOnboardOrGreet(phone, fresh);
  }

  let user = await ensureCaller(phone);

  if (!isOnboarded(user)) {
    return continueOnboardOrGreet(phone, user);
  }

  if (intent.action === "help" || intent.action === "unknown") {
    const tip =
      "Try saying balance, send one dollar, exchange one dollar to euro, or buy ten euro airtime.";
    return {
      reply: withName(
        user,
        intent.action === "unknown" ? `I didn't catch that. ${tip}` : tip,
      ),
    };
  }

  if (intent.action === "set_policy") {
    const rules = await compilePolicySmart(intent.spoken);
    if (!rules?.length) {
      return {
        reply: withName(
          user,
          `Couldn't compile that into a rule. Try: never send more than ten dollars to someone I haven't paid before.`,
        ),
      };
    }
    await setPending(phone, { type: "awaiting_policy_confirm", rules } satisfies PendingPolicy);
    return {
      reply: withName(
        user,
        `I heard: ${describeRules(rules)} Confirm with your PIN to freeze it, then even I can't loosen it.`,
      ),
      needsPin: true,
      data: { draftRules: rules },
    };
  }

  if (intent.action === "show_policy") {
    const rules = await loadFrozenRules(phone);
    if (!rules.length) {
      return { reply: withName(user, "No frozen rules yet. Say POLICY never send more than ten…") };
    }
    return { reply: withName(user, `Your rules: ${describeRules(rules)}`), data: { rules } };
  }

  if (intent.action === "clear_policy") {
    await clearFrozenRules(phone);
    return { reply: withName(user, "All spoken rules cleared.") };
  }

  if (intent.action === "standing") {
    const payee = await resolvePayee(phone, intent.to);
    if (!payee) {
      return { reply: withName(user, `I don't know "${intent.to}".`) };
    }
    await setPending(phone, {
      type: "awaiting_standing_confirm",
      amount: intent.amount,
      toLabel: payee.label,
      toPhone: payee.phone,
      toAddress: payee.address,
      cadence: intent.cadence,
    } satisfies PendingStanding);
    return {
      reply: withName(
        user,
        `Standing ${intent.amount} dollars to ${payee.label} ${intent.cadence}.`,
      ),
      needsPin: true,
    };
  }

  if (intent.action === "list_standing") {
    const rows = await listStandingOrders(phone);
    if (!rows.length) return { reply: withName(user, "No standing orders.") };
    return {
      reply: withName(
        user,
        rows
          .map((r) => `#${r.id} ${r.amount_usdc}→${r.to_label} ${r.cadence} next ${r.next_run_at.slice(0, 10)}`)
          .join("; "),
      ),
    };
  }

  if (intent.action === "cancel_standing") {
    const ok = await cancelStandingOrder(phone, intent.id);
    return {
      reply: withName(user, ok ? `Cancelled standing #${intent.id}.` : `No active standing #${intent.id}.`),
    };
  }

  if (intent.action === "lock_savings") {
    const until = parseUnlockDate(intent.until);
    if (!until) {
      return { reply: withName(user, "Say LOCK 5 until December, or LOCK 5 until 2026-12-01.") };
    }
    const bal = await getUsdcBalance(user.wallet_address as Address, user.wallet_ref);
    const avail = await availableUsdc(phone, bal);
    if (intent.amount > avail.available + 1e-9) {
      return {
        reply: withName(
          user,
          `Only $${avail.available.toFixed(2)} available ($${avail.locked.toFixed(2)} already locked).`,
        ),
      };
    }
    await setPending(phone, {
      type: "awaiting_lock_confirm",
      amount: intent.amount,
      unlockAt: until.toISOString(),
    } satisfies PendingLock);
    return {
      reply: withName(
        user,
        `Lock $${intent.amount} until ${until.toISOString().slice(0, 10)}?`,
      ),
      needsPin: true,
    };
  }

  if (intent.action === "list_locks") {
    const rows = await listSavingsLocks(phone);
    if (!rows.length) return { reply: withName(user, "No active savings locks.") };
    return {
      reply: withName(
        user,
        rows.map((r) => `$${r.amount_usdc} until ${r.unlock_at.slice(0, 10)}`).join("; "),
      ),
    };
  }

  if (intent.action === "shop") {
    const hit = await shopSearch({ query: intent.query, phone, limit: 5, web: false });
    if (!hit.ok) return { reply: withName(user, hit.summary) };
    await setPending(phone, {
      type: "shop_results",
      products: hit.products,
    } satisfies PendingShop);
    const short = hit.products
      .map((p, i) => `${i + 1}. ${p.title} $${p.price}`)
      .join("; ");
    return {
      reply: withName(
        user,
        `Shop: ${short}. Say BUY 1 or BUY ${hit.products[0]?.handle ?? "handle"}, I'll text a cart link (you approve payment). Full Shop skill: ${shopSkillUrl()}`,
      ),
      data: { products: hit.products, skill: hit.skillHint },
    };
  }

  if (intent.action === "buy") {
    const pending = await getPending<PendingShop>(phone);
    let product: ShopProduct | null = null;
    const key = intent.handleOrIndex;
    if (/^\d+$/.test(key) && pending?.type === "shop_results") {
      product = pending.products[Number(key) - 1] ?? null;
    }
    if (!product) {
      product = await enrichCircleProduct(key);
    }
    if (!product && pending?.type === "shop_results") {
      product =
        pending.products.find((p) => p.handle === key || p.title.toLowerCase().includes(key)) ??
        null;
    }
    if (!product) {
      return {
        reply: withName(
          user,
          `Couldn't pick that item. Say SHOP tee first, then BUY 1. Or BUY unisex-tee.`,
        ),
      };
    }
    if (product.source === "circle_shop" && !product.variantId && product.handle) {
      product = (await enrichCircleProduct(product.handle)) ?? product;
    }
    const checkout = cartCheckoutUrl(product, 1);
    if (canReceiveSms(phone) && checkout) {
      void sms
        .send(
          phone,
          `hotline.guru cart: ${product.title} $${product.price}. You approve & pay: ${checkout}`,
        )
        .catch(() => {});
    }
    await setPending(phone, null);
    return {
      reply: withName(
        user,
        `Cart for ${product.title} ($${product.price}). Open the link I texted to pay, agents never auto-complete. ${checkout ?? product.url}`,
      ),
      data: {
        product,
        checkoutUrl: checkout,
        requiresHumanApproval: true,
        skill: shopSkillUrl(),
      },
    };
  }

  if (intent.action === "identity") {
    return { reply: withName(user, identitySummary(user)) };
  }

  if (intent.action === "claim_name") {
    try {
      const { label } = await claimName(phone, intent.name);
      return {
        reply: withName(user, `You're ${label}. People can send to that name, no hex.`),
        data: { hotline: label },
      };
    } catch (e) {
      return { reply: withName(user, String(e instanceof Error ? e.message : e)) };
    }
  }

  if (intent.action === "whois") {
    const hit = await lookupName(intent.name);
    if (!hit) return { reply: withName(user, `${intent.name} is not registered.`) };
    return {
      reply: withName(
        user,
        `${hit.label} is registered${hit.displayName ? ` (${hit.displayName})` : ""}.`,
      ),
      data: { whois: { label: hit.label, displayName: hit.displayName } },
    };
  }

  if (intent.action === "verify_id") {
    try {
      const updated = await verifyNationalId(phone, intent.nationalId);
      return {
        reply: withName(user, `ID recorded (hashed). ${identitySummary(updated)}`),
        data: { tier: updated.identity_tier },
      };
    } catch (e) {
      return { reply: withName(user, String(e instanceof Error ? e.message : e)) };
    }
  }

  if (intent.action === "attest_sim") {
    const result = await attestSim(phone);
    return {
      reply: withName(user, result.summary),
      data: { tier: result.user.identity_tier, mode: result.mode },
    };
  }

  if (intent.action === "balance") {
    const bal = await getUsdcBalance(user.wallet_address as Address, user.wallet_ref);
    const avail = await availableUsdc(phone, bal);
    const lockedBit = avail.locked ? `, ${formatSpokenUsdc(avail.locked)} locked` : "";
    let extra = "";
    try {
      const [eurc, cirbtc] = await Promise.all([
        getTokenBalance(user.wallet_address as Address, "EURC"),
        getTokenBalance(user.wallet_address as Address, "cirBTC"),
      ]);
      const bits: string[] = [];
      if (eurc > 1e-6) bits.push(`${eurc.toFixed(2)} euro`);
      if (cirbtc > 1e-8) bits.push(`${cirbtc.toFixed(8)} circle bitcoin`);
      if (bits.length) extra = ` Also ${bits.join(" and ")}.`;
    } catch {
      /* RPC optional extras */
    }
    return {
      reply: withName(
        user,
        `Your balance is ${formatSpokenUsdc(avail.balance)} on Arc. ${formatSpokenUsdc(avail.available)} available${lockedBit}.${extra}`,
      ),
      data: avail,
    };
  }

  if (intent.action === "deposit") {
    const dep = exportDepositInfo(user);
    return {
      reply: withName(user, `Deposit USDC on Arc Testnet to ${dep.address}. Faucet: ${dep.faucet}`),
      data: dep,
    };
  }

  if (intent.action === "contacts") {
    const rows = (await listContacts(phone)) as {
      contact_name: string;
      contact_address: string | null;
    }[];
    if (!rows.length) return { reply: withName(user, "No contacts yet.") };
    return {
      reply: withName(
        user,
        rows.map((r) => `${r.contact_name}: ${r.contact_address ?? "?"}`).join("; "),
      ),
    };
  }

  if (intent.action === "history") {
    const rows = await listLedger(phone, 5);
    if (!rows.length) return { reply: withName(user, "No transactions yet.") };
    return {
      reply: withName(
        user,
        rows
          .map((r) => {
            const tx = r.tx_hash ? ` ${r.tx_hash.slice(0, 10)}…` : "";
            return `${r.kind} ${r.amount_usdc} USDC${tx}`;
          })
          .join("; "),
      ),
      data: { rows },
    };
  }

  if (intent.action === "save") {
    const target = intent.target;
    if (isAddress(target)) {
      await saveContact(phone, intent.name, { contactAddress: target });
    } else if (target.startsWith("+") || /^\d+$/.test(target)) {
      await saveContact(phone, intent.name, { contactPhone: normalizePhone(target) });
    } else {
      return { reply: "SAVE needs an address (0x…) or phone." };
    }
    return { reply: withName(user, `Saved contact ${intent.name}.`) };
  }

  if (intent.action === "price") {
    const verdict = await evaluatePolicy(phone, intent);
    await recordPolicyDecision({
      phone,
      action: "price",
      verdict: verdict.status,
      reason: "reason" in verdict ? verdict.reason : undefined,
      intent,
    });
    if (verdict.status === "reject") return { reply: withName(user, `Rejected: ${verdict.reason}`) };
    const price = await fetchCryptoPrice(intent.symbol, phone);
    return { reply: withName(user, price.summary), data: { mode: price.mode } };
  }

  if (intent.action === "send") {
    const payee = await resolvePayee(phone, intent.to);
    if (!payee) {
      const asName = normalizeHotlineLabel(intent.to);
      const looksName =
        /\.hotline$/i.test(intent.to) ||
        (/^[a-z][a-z0-9-]{1,31}$/i.test(asName) && !intent.to.startsWith("+") && !/^\d+$/.test(intent.to));
      if (looksName && asName) {
        return {
          reply: withName(
            user,
            `${asName}.hotline is not registered yet. Ask them to call the hotline and say CLAIM ${asName}, or send to their phone with country code, like plus three five three…`,
          ),
        };
      }
      return {
        reply: withName(
          user,
          `I don't know "${intent.to}". Send to a phone number with country code, like plus three five three…, or a registered .hotline name.`,
        ),
      };
    }

    const verdict = await evaluatePolicy(phone, intent, {
      payeeLabel: payee.label,
      payeePhone: payee.phone,
    });
    await recordPolicyDecision({
      phone,
      action: "send",
      verdict: verdict.status,
      reason: "reason" in verdict ? verdict.reason : undefined,
      amount_usdc: intent.amount,
      payee: intent.to,
      intent,
    });
    if (verdict.status === "reject") {
      return { reply: withName(user, `No. ${verdict.reason}`) };
    }
    if (verdict.status === "callback") {
      return { reply: withName(user, verdict.reason) };
    }

    const pendingSend: PendingSend = {
      type: "send",
      amount: intent.amount,
      toLabel: payee.label,
      toAddress: payee.address,
      toPhone: payee.phone,
      provisioned: false,
      pendingClaim: Boolean(payee.pendingClaim),
      idemKey: `send:${phone}:${randomUUID()}`,
      memoText: intent.memo,
    };

    if (demoSimple()) {
      return executeSend(phone, pendingSend, user);
    }

    await setPending(phone, pendingSend);
    const claimHint = payee.pendingClaim
      ? ` Held in escrow until they onboard (expires in ${pendingClaimDays()} days if unclaimed).`
      : "";
    return {
      reply: withName(
        user,
        `Confirm send ${intent.amount} dollars to ${payee.label}? Send your PIN to confirm.${claimHint}`,
      ),
      spoken: withName(
        user,
        `Confirm send ${intent.amount} dollars to ${payee.label}?`,
      ),
      needsPin: true,
      needsMemo: !intent.memo,
      data: {
        amount: intent.amount,
        to: payee.label,
        toPhone: payee.phone,
        pendingClaim: payee.pendingClaim ?? false,
        idemKey: pendingSend.idemKey,
        offerMemo: true,
      },
    };
  }

  if (intent.action === "swap") {
    const verdict = await evaluatePolicy(phone, intent);
    await recordPolicyDecision({
      phone,
      action: "swap",
      verdict: verdict.status,
      reason: "reason" in verdict ? verdict.reason : undefined,
      amount_usdc: intent.tokenIn === "USDC" ? intent.amount : undefined,
      intent,
    });
    if (verdict.status === "reject") {
      return { reply: withName(user, `No. ${verdict.reason}`) };
    }

    const estimate = await estimateArcSwap({
      phone,
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
      amountIn: intent.amount,
    });
    const pendingSwap: PendingSwap = {
      type: "swap",
      amount: intent.amount,
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
      estimatedOut: estimate?.estimatedOutput || undefined,
      idemKey: `swap:${phone}:${randomUUID()}`,
    };

    if (demoSimple()) {
      return executeSwap(phone, pendingSwap, user);
    }

    await setPending(phone, pendingSwap);
    const fromLabel = spokenToken(intent.tokenIn);
    const toLabel = spokenToken(intent.tokenOut);
    const quote = estimate?.estimatedOutput
      ? ` About ${estimate.estimatedOutput} ${toLabel} expected.`
      : "";
    const quoteSms = estimate?.estimatedOutput
      ? ` About ${estimate.estimatedOutput} ${toLabel} expected (via Circle Swap).`
      : " Routed on Arc via Circle Swap.";
    return {
      reply: withName(
        user,
        `Confirm swap ${intent.amount} ${fromLabel} to ${toLabel}?${quoteSms} Send your PIN to confirm.`,
      ),
      spoken: withName(
        user,
        `Confirm swap ${intent.amount} ${fromLabel} to ${toLabel}?${quote}`,
      ),
      needsPin: true,
      data: {
        amount: intent.amount,
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        estimatedOut: estimate?.estimatedOutput,
        idemKey: pendingSwap.idemKey,
      },
    };
  }

  if (intent.action === "topup") {
    const msisdn = intent.to ? normalizePhone(intent.to) : phone;
    const quote = buildAirtimeQuote({
      faceAmount: intent.amount,
      faceCurrency: intent.currency,
      msisdn,
    });
    const verdict = await evaluatePolicy(phone, intent);
    await recordPolicyDecision({
      phone,
      action: "topup",
      verdict: verdict.status,
      reason: "reason" in verdict ? verdict.reason : undefined,
      amount_usdc: quote.chargeUsdc,
      payee: msisdn,
      intent,
    });
    if (verdict.status === "reject") {
      return { reply: withName(user, `No. ${verdict.reason}`) };
    }

    const pendingTopup: PendingTopup = {
      type: "topup",
      faceAmount: quote.faceAmount,
      faceCurrency: quote.faceCurrency,
      chargeUsdc: quote.chargeUsdc,
      msisdn: quote.msisdn,
      productLabel: quote.productLabel,
      idemKey: `topup:${phone}:${randomUUID()}`,
    };

    if (demoSimple()) {
      return executeTopup(phone, pendingTopup, user);
    }

    await setPending(phone, pendingTopup);
    const face =
      quote.faceCurrency === "EUR"
        ? `${quote.faceAmount} euro`
        : `${quote.faceAmount} dollars`;
    return {
      reply: withName(
        user,
        `Confirm ${face} airtime for ${quote.msisdn}? Costs about ${quote.chargeUsdc} USDC.`,
      ),
      spoken: withName(
        user,
        `Confirm ${face} airtime for your number? About ${quote.chargeUsdc} dollars.`,
      ),
      needsPin: true,
      data: {
        ...quote,
        idemKey: pendingTopup.idemKey,
      },
    };
  }

  return { reply: "Unhandled." };
}

async function executeSend(
  phone: string,
  pending: PendingSend,
  user?: User | null,
): Promise<HandleResult> {
  const u = user ?? (await getUser(phone));
  const idemKey =
    pending.idemKey ??
    `send:${phone}:${pending.toAddress ?? "claim"}:${pending.amount.toFixed(6)}:${pending.toPhone ?? ""}`;

  const claim = await claimIdempotency<HandleResult>(idemKey, phone);
  if (claim.status === "completed") {
    log.info("idempotent hit", { phone, idemKey: shortHash(idemKey) });
    return claim.result;
  }
  if (claim.status === "inflight") {
    return {
      reply: withName(u, "That transfer is already in progress. Wait a moment, then check HISTORY."),
    };
  }

  const asyncMode =
    process.env.ASYNC_SETTLE === "1" ||
    (process.env.ASYNC_SETTLE === "voice" && process.env.HOTLINE_VOICE === "1");

  const run = async (): Promise<HandleResult> => {
    if (pending.pendingClaim && pending.toPhone) {
      const { claim: pc, txHash, explorer } = await holdPendingClaim({
        fromPhone: phone,
        toPhone: pending.toPhone,
        amountUsdc: pending.amount,
        idemKey,
      });
      await setPending(phone, null);
      const memoBit = pending.memoText ? ` Memo queued: "${pending.memoText.slice(0, 80)}".` : "";
      const result: HandleResult = {
        reply: withName(
          u,
          `Held ${pending.amount} USDC for ${pending.toLabel} in escrow (claim #${pc.id}). They get it when they onboard within ${pendingClaimDays()} days; else it returns to you.${memoBit} Tx ${txHash.slice(0, 12)}… ${explorer}`,
        ),
        spoken: withName(
          u,
          `Held ${pending.amount} dollars for ${pending.toLabel} in escrow. They get it when they join.`,
        ),
        data: {
          txHash,
          explorer,
          to: pending.toLabel,
          pendingClaim: true,
          claimId: pc.id,
          idemKey,
          memo: pending.memoText,
        },
      };
      await saveIdempotentResult(idemKey, phone, result);
      if (canReceiveSms(phone)) {
        void sms.send(phone, result.reply).catch(() => {});
      }
      return result;
    }

    if (!pending.toAddress) {
      throw new Error("Missing payee address");
    }

    const { txHash, explorer } = await transferUsdc({
      fromPhone: phone,
      toAddress: pending.toAddress,
      amountUsdc: pending.amount,
    });
    await addLedger({
      phone,
      kind: "send",
      amount_usdc: pending.amount,
      counterparty: pending.toPhone ?? pending.toAddress,
      tx_hash: txHash,
      meta: pending.memoText
        ? JSON.stringify({ memo: pending.memoText })
        : undefined,
    });
    if (pending.toPhone) {
      await addLedger({
        phone: pending.toPhone,
        kind: "receive",
        amount_usdc: pending.amount,
        counterparty: phone,
        tx_hash: txHash,
        meta: pending.memoText
          ? JSON.stringify({ memo: pending.memoText })
          : undefined,
      });
    }
    await setPending(phone, null);

    const where = pending.toPhone ?? pending.toLabel;
    const memoBit = pending.memoText ? ` Memo: "${pending.memoText.slice(0, 120)}".` : "";
    const result: HandleResult = {
      reply: withName(
        u,
        `Sent ${pending.amount} USDC to ${where}.${memoBit} Tx ${txHash.slice(0, 12)}… ${explorer}`,
      ),
      spoken: withName(u, `Sent ${pending.amount} dollars to ${where}.${memoBit}`),
      data: {
        txHash,
        explorer,
        to: where,
        toAddress: pending.toAddress,
        provisioned: false,
        idemKey,
        memo: pending.memoText,
      },
      needsMemo: !pending.memoText,
    };
    await saveIdempotentResult(idemKey, phone, result);

    if (canReceiveSms(phone)) {
      void sms
        .send(phone, result.reply)
        .catch((err) => log.warn("sms receipt failed", { err: String(err) }));
    }
    if (pending.toPhone && canReceiveSms(pending.toPhone)) {
      const payeeMsg = pending.memoText
        ? `Voice note from hotline: "${pending.memoText.slice(0, 160)}". Then: you received ${pending.amount} USDC, call hotline.guru to claim.`
        : `You have ${pending.amount} USDC waiting on hotline.guru, call the hotline to claim.`;
      void sms.send(pending.toPhone, payeeMsg).catch(() => {});
    }
    log.info("send ok", { phone, to: where, amount: pending.amount, txHash, explorer });
    return result;
  };

  if (asyncMode) {
    void run().catch((e) => log.error("async settle failed", { err: String(e), phone }));
    return {
      reply: withName(
        u,
        `Sending ${pending.amount} USDC to ${pending.toLabel} now. I'll let you know when it lands.`,
      ),
      data: { async: true, idemKey, to: pending.toLabel },
    };
  }

  try {
    return await run();
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.error("send failed", { phone, err });
    return {
      reply: withName(u, `Couldn't send: ${err}. Fund first (faucet or fund-user.sh).`),
    };
  }
}

async function executeSwap(
  phone: string,
  pending: PendingSwap,
  user?: User | null,
): Promise<HandleResult> {
  const u = user ?? (await getUser(phone));
  const idemKey =
    pending.idemKey ??
    `swap:${phone}:${pending.tokenIn}:${pending.tokenOut}:${pending.amount.toFixed(8)}`;

  const claim = await claimIdempotency<HandleResult>(idemKey, phone);
  if (claim.status === "completed") {
    log.info("idempotent swap hit", { phone, idemKey: shortHash(idemKey) });
    return claim.result;
  }
  if (claim.status === "inflight") {
    return {
      reply: withName(u, "That swap is already in progress. Wait a moment, then check HISTORY."),
    };
  }

  const asyncMode =
    process.env.ASYNC_SETTLE === "1" ||
    (process.env.ASYNC_SETTLE === "voice" && process.env.HOTLINE_VOICE === "1");

  const run = async (): Promise<HandleResult> => {
    const { txHash, amountOut, explorer } = await executeArcSwap({
      phone,
      tokenIn: pending.tokenIn,
      tokenOut: pending.tokenOut,
      amountIn: pending.amount,
    });
    await addLedger({
      phone,
      kind: "swap",
      amount_usdc: pending.tokenIn === "USDC" ? pending.amount : 0,
      counterparty: `${pending.tokenIn}->${pending.tokenOut}`,
      tx_hash: txHash,
      meta: JSON.stringify({
        tokenIn: pending.tokenIn,
        tokenOut: pending.tokenOut,
        amountIn: pending.amount,
        amountOut,
      }),
    });
    await setPending(phone, null);

    const fromLabel = spokenToken(pending.tokenIn);
    const toLabel = spokenToken(pending.tokenOut);
    const outBit = amountOut ? ` Got about ${amountOut} ${toLabel}.` : "";
    const result: HandleResult = {
      reply: withName(
        u,
        `Swapped ${pending.amount} ${fromLabel} to ${toLabel}.${outBit} Tx ${txHash.slice(0, 12)}… ${explorer}`,
      ),
      spoken: withName(u, `Done. Swapped ${pending.amount} ${fromLabel} to ${toLabel}.${outBit}`),
      data: {
        txHash,
        explorer,
        tokenIn: pending.tokenIn,
        tokenOut: pending.tokenOut,
        amountIn: pending.amount,
        amountOut,
        idemKey,
      },
    };
    await saveIdempotentResult(idemKey, phone, result);
    if (canReceiveSms(phone)) {
      void sms.send(phone, result.reply).catch(() => {});
    }
    log.info("swap ok", {
      phone,
      tokenIn: pending.tokenIn,
      tokenOut: pending.tokenOut,
      amount: pending.amount,
      txHash,
    });
    return result;
  };

  if (asyncMode) {
    void run().catch((e) => log.error("async swap failed", { err: String(e), phone }));
    return {
      reply: withName(
        u,
        `Swapping ${pending.amount} ${spokenToken(pending.tokenIn)} to ${spokenToken(pending.tokenOut)} now. I'll let you know when it lands.`,
      ),
      data: { async: true, idemKey },
    };
  }

  try {
    return await run();
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.error("swap failed", { phone, err });
    return {
      reply: withName(
        u,
        `Couldn't swap: ${err}. Need ${spokenToken(pending.tokenIn)} in the wallet, and a KIT_KEY for Circle Swap on Arc.`,
      ),
    };
  }
}

async function executeTopup(
  phone: string,
  pending: PendingTopup,
  user?: User | null,
): Promise<HandleResult> {
  const u = user ?? (await getUser(phone));
  const idemKey =
    pending.idemKey ??
    `topup:${phone}:${pending.msisdn}:${pending.faceAmount}:${pending.faceCurrency}`;

  const claim = await claimIdempotency<HandleResult>(idemKey, phone);
  if (claim.status === "completed") {
    return claim.result;
  }
  if (claim.status === "inflight") {
    return {
      reply: withName(u, "That top-up is already in progress. Check HISTORY in a moment."),
    };
  }

  const asyncMode =
    process.env.ASYNC_SETTLE === "1" ||
    (process.env.ASYNC_SETTLE === "voice" && process.env.HOTLINE_VOICE === "1");

  const run = async (): Promise<HandleResult> => {
    const fulfilled = await fulfillAirtime({
      fromPhone: phone,
      quote: {
        faceAmount: pending.faceAmount,
        faceCurrency: pending.faceCurrency,
        chargeUsdc: pending.chargeUsdc,
        msisdn: pending.msisdn,
        provider: (process.env.AIRTIME_PROVIDER ?? "mock").toLowerCase(),
        productLabel: pending.productLabel,
      },
    });
    await addLedger({
      phone,
      kind: "airtime",
      amount_usdc: pending.chargeUsdc,
      counterparty: pending.msisdn,
      tx_hash: fulfilled.txHash,
      meta: JSON.stringify({
        faceAmount: pending.faceAmount,
        faceCurrency: pending.faceCurrency,
        voucherId: fulfilled.voucherId,
        productLabel: pending.productLabel,
      }),
    });
    await setPending(phone, null);

    const face =
      pending.faceCurrency === "EUR"
        ? `${pending.faceAmount} euro`
        : `${pending.faceAmount} dollars`;
    const result: HandleResult = {
      reply: withName(
        u,
        `Topped up ${face} airtime for ${pending.msisdn}. Voucher ${fulfilled.voucherId}.${fulfilled.explorer ? ` ${fulfilled.explorer}` : ""}`,
      ),
      spoken: withName(
        u,
        `Done. ${face} airtime is on the way to your number.`,
      ),
      data: {
        voucherId: fulfilled.voucherId,
        txHash: fulfilled.txHash,
        explorer: fulfilled.explorer,
        msisdn: pending.msisdn,
        chargeUsdc: pending.chargeUsdc,
        idemKey,
      },
    };
    await saveIdempotentResult(idemKey, phone, result);
    if (canReceiveSms(phone)) {
      void sms.send(phone, result.reply).catch(() => {});
    }
    if (pending.msisdn !== phone && canReceiveSms(pending.msisdn)) {
      void sms
        .send(
          pending.msisdn,
          `hotline.guru: ${face} airtime top-up from ${phone}. Voucher ${fulfilled.voucherId}.`,
        )
        .catch(() => {});
    }
    return result;
  };

  if (asyncMode) {
    void run().catch((e) => log.error("async topup failed", { err: String(e), phone }));
    return {
      reply: withName(u, `Buying airtime now, I'll text you when it's done.`),
      spoken: withName(u, `Buying airtime now, I'll text you when it's done.`),
      data: { async: true, idemKey },
    };
  }

  try {
    return await run();
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.error("topup failed", { phone, err });
    return {
      reply: withName(u, `Couldn't top up: ${err}. Need USDC in the wallet.`),
      spoken: withName(u, `Couldn't top up. Check your dollar balance.`),
    };
  }
}

/** Attach a spoken memo to the pending send (AGI voice note before/after PIN). */
export async function attachSendMemo(phoneRaw: string, memoText: string): Promise<HandleResult> {
  const phone = normalizePhone(phoneRaw);
  const pending = await getPending<PendingSend>(phone);
  if (pending?.type === "send") {
    pending.memoText = memoText.slice(0, 280);
    await setPending(phone, pending);
    return {
      reply: "Got your voice note, it'll ride with the payment.",
      data: { memo: pending.memoText },
    };
  }
  return { reply: "No pending send to attach a memo to." };
}
