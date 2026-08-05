import { randomUUID } from "node:crypto";
import { isAddress, type Address } from "viem";
import {
  addLedger,
  claimIdempotency,
  clearPinFailures,
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
  setPending,
  setPin,
  setUserName,
  type User,
} from "./db.js";
import { resolvePayee } from "./contacts.js";
import { claimName, lookupName, suggestHotlineName } from "./hotlinens.js";
import { attestSim, identitySummary, verifyNationalId } from "./identity.js";
import { parseIntentSmart, parseNameAnswer, type Intent } from "./intent.js";
import { evaluatePolicy, policyLimits } from "./policy.js";
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
import { log, shortHash } from "./log.js";

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
  data?: Record<string, unknown>;
  needsName?: boolean;
  needsPin?: boolean;
  needsSetPin?: boolean;
  onboarding?: boolean;
};

type PendingSend = {
  type: "send";
  amount: number;
  toLabel: string;
  toAddress: Address;
  toPhone?: string;
  provisioned?: boolean;
  idemKey?: string;
};

type PendingName = { type: "awaiting_name" };

function firstName(user: User | null | undefined): string | null {
  const n = user?.name?.trim();
  return n ? n.split(/\s+/)[0]! : null;
}

function withName(user: User | null | undefined, body: string): string {
  const n = firstName(user);
  return n ? `Hey ${n} — ${body}` : body;
}

function isOnboarded(user: User): boolean {
  if (!user.name) return false;
  if (demoSimple()) return true;
  return !!user.pin_hash;
}

export async function handleMessage(phoneRaw: string, text: string): Promise<HandleResult> {
  const phone = normalizePhone(phoneRaw);
  const intent = await parseIntentSmart(text);
  return dispatch(phone, intent, text);
}

export async function handleCallStart(phoneRaw: string): Promise<HandleResult> {
  const phone = normalizePhone(phoneRaw);
  const user = await ensureCaller(phone);
  return continueOnboardOrGreet(phone, user);
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
      reply: `Welcome back, ${firstName(user)}. Finish setup — choose a 4-digit PIN on the keypad, then pound.`,
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
    reply: `Nice to meet you, ${firstName(user)}. Your Arc wallet is ready.${nsHint} Choose a 4-digit PIN on the keypad, then pound.`,
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
    ? `Thanks, ${firstName(fresh)}. You're all set on this number. Call anytime to send USDC to another phone number.`
    : "PIN set. You're ready.";

  void (canReceiveSms(phone)
    ? sms
        .send(
          phone,
          `hotline.guru: hi ${firstName(fresh) ?? "there"}. Deposit Arc USDC to ${dep.address}`,
        )
        .catch(() => {})
    : undefined);

  return {
    reply,
    onboarding: false,
    data: { name: fresh.name, address: dep.address, onboarded: true },
  };
}

async function dispatch(phone: string, intent: Intent, raw: string): Promise<HandleResult> {
  const awaiting = await getPending<PendingName | PendingSend>(phone);

  if (awaiting?.type === "awaiting_name") {
    if (intent.action === "set_name") return finishNaming(phone, intent.name);
    const bare = parseNameAnswer(raw);
    if (bare) return finishNaming(phone, bare);
    return {
      reply: "Just tell me your first name — for example, Ben.",
      needsName: true,
      onboarding: true,
    };
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
    // Already onboarded — require re-auth: CHANGE PIN <old> <new> via confirm flow
    if (user.pin_hash && isOnboarded(user) && !demoSimple()) {
      return {
        reply: withName(
          user,
          "PIN already set. To change it, say CHANGE PIN then enter old PIN and new PIN on the keypad.",
        ),
      };
    }
    return completePinSetup(phone, intent.pin);
  }

  if (intent.action === "cancel") {
    const pending = await getPending<PendingName | PendingSend>(phone);
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

  if (intent.action === "confirm") {
    const pending = await getPending<PendingSend>(phone);
    if (!pending || pending.type !== "send") {
      return { reply: "Nothing pending to confirm." };
    }
    const user = await ensureCaller(phone);
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
    const pin = intent.pin ?? (demoSimple() ? demoPin() : undefined);
    if (!pin) {
      return {
        reply: "Enter your PIN on the keypad, or say yes and your PIN.",
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
    const limits = policyLimits(user.identity_tier ?? 0);
    const tip = `Say: send 2 to alice.hotline or a phone. Tier ${limits.tier} soft $${limits.perTx}, hard $${limits.hardCeiling}. CLAIM name · VERIFY ID · ATTEST · IDENTITY.`;
    return {
      reply: withName(
        user,
        intent.action === "unknown" ? `I didn't catch that. ${tip}` : tip,
      ),
    };
  }

  if (intent.action === "identity") {
    return { reply: withName(user, identitySummary(user)) };
  }

  if (intent.action === "claim_name") {
    try {
      const { label } = await claimName(phone, intent.name);
      return {
        reply: withName(user, `You're ${label}. People can send to that name — no hex.`),
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
    return { reply: withName(user, `Balance: ${bal.toFixed(2)} USDC on Arc.`) };
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
    const verdict = await evaluatePolicy(phone, intent);
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
      return { reply: withName(user, `No — ${verdict.reason}`) };
    }
    const payee = await resolvePayee(phone, intent.to);
    if (!payee) {
      return {
        reply: withName(
          user,
          `I don't know "${intent.to}". Send to a phone number like +15551234567.`,
        ),
      };
    }

    const pendingSend: PendingSend = {
      type: "send",
      amount: intent.amount,
      toLabel: payee.label,
      toAddress: payee.address,
      toPhone: payee.phone,
      provisioned: payee.provisioned,
      // Stable for confirm retries; unique per send intent
      idemKey: `send:${phone}:${randomUUID()}`,
    };

    if (demoSimple()) {
      return executeSend(phone, pendingSend, user);
    }

    await setPending(phone, pendingSend);
    const provisionHint = payee.provisioned
      ? " We'll open their hotline wallet now — it's theirs when they call in."
      : "";
    return {
      reply: withName(
        user,
        `Confirm send ${intent.amount} USDC to ${payee.label}? Enter your PIN on the keypad, then pound.${provisionHint}`,
      ),
      needsPin: true,
      data: {
        amount: intent.amount,
        to: payee.label,
        toPhone: payee.phone,
        provisioned: payee.provisioned,
        idemKey: pendingSend.idemKey,
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
    `send:${phone}:${pending.toAddress}:${pending.amount.toFixed(6)}:${pending.toPhone ?? ""}`;

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

  try {
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
    });
    if (pending.toPhone) {
      await addLedger({
        phone: pending.toPhone,
        kind: "receive",
        amount_usdc: pending.amount,
        counterparty: phone,
        tx_hash: txHash,
      });
    }
    await setPending(phone, null);

    const where = pending.toPhone ?? pending.toLabel;
    const provisionNote = pending.provisioned
      ? " Their wallet is ready whenever they call the hotline."
      : "";
    const reply = withName(
      u,
      `Sent ${pending.amount} USDC to ${where}.${provisionNote} Tx ${txHash.slice(0, 12)}… ${explorer}`,
    );
    const result: HandleResult = {
      reply,
      data: {
        txHash,
        explorer,
        to: where,
        toAddress: pending.toAddress,
        provisioned: pending.provisioned ?? false,
        idemKey,
      },
    };
    await saveIdempotentResult(idemKey, phone, result);

    if (canReceiveSms(phone)) {
      void sms.send(phone, reply).catch((err) => log.warn("sms receipt failed", { err: String(err) }));
    }
    if (pending.toPhone && canReceiveSms(pending.toPhone)) {
      void sms
        .send(
          pending.toPhone,
          `You received ${pending.amount} USDC on Arc via hotline.guru. Call the hotline to claim your number.`,
        )
        .catch(() => {});
    }
    log.info("send ok", { phone, to: where, amount: pending.amount, txHash, explorer });
    return result;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.error("send failed", { phone, err });
    return {
      reply: withName(
        u,
        `Couldn't send: ${err}. Fund first (faucet or fund-user.sh).`,
      ),
    };
  }
}
