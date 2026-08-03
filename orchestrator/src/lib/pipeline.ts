import { isAddress, type Address } from "viem";
import {
  addLedger,
  getPending,
  getUser,
  listContacts,
  listLedger,
  saveContact,
  setPending,
  setPin,
  setUserName,
  normalizePhone,
  type User,
} from "./db.js";
import { resolvePayee } from "./contacts.js";
import { parseIntentSmart, parseNameAnswer, type Intent } from "./intent.js";
import { evaluatePolicy, policyLimits } from "./policy.js";
import { fetchCryptoPrice, phoneFraudLookup } from "./marketplace.js";
import { createSmsProvider } from "./sms.js";
import {
  ensureWallet,
  exportDepositInfo,
  getUsdcBalance,
  hashPin,
  transferUsdc,
  verifyPin,
} from "./wallets.js";

const sms = createSmsProvider();

/** Opt-in one-shot demo. Default is real PIN confirm + full onboard. */
function demoSimple(): boolean {
  return process.env.DEMO_SIMPLE === "1";
}

function demoPin(): string {
  return process.env.DEMO_PIN ?? "1234";
}

export type HandleResult = {
  reply: string;
  data?: Record<string, unknown>;
  needsName?: boolean;
  /** Pending send — collect PIN (prefer DTMF) then CONFIRM. */
  needsPin?: boolean;
  /** Onboard or resume — collect digits then PIN ####. */
  needsSetPin?: boolean;
  /** True while first-call onboard is still running. */
  onboarding?: boolean;
};

type PendingSend = {
  type: "send";
  amount: number;
  toLabel: string;
  toAddress: Address;
  toPhone?: string;
  provisioned?: boolean;
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

/** Name + PIN (wallet is created at first touch). Demo-simple auto-fills PIN. */
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

/**
 * Pickup: create Arc wallet for this number if needed, then
 * welcome → name → PIN, or greet a fully onboarded caller.
 */
export async function handleCallStart(phoneRaw: string): Promise<HandleResult> {
  const phone = normalizePhone(phoneRaw);
  const user = await ensureCaller(phone);
  return continueOnboardOrGreet(phone, user);
}

async function ensureCaller(phone: string) {
  let user = getUser(phone);
  if (!user) {
    // Creates Arc wallet + phone row (receiver funds already land here if pre-provisioned)
    user = await ensureWallet(phone);
  }
  if (demoSimple() && !user.pin_hash) {
    setPin(phone, hashPin(demoPin()));
    user = getUser(phone)!;
  }
  return user;
}

async function continueOnboardOrGreet(phone: string, user: User): Promise<HandleResult> {
  if (!user.name) {
    setPending(phone, { type: "awaiting_name" } satisfies PendingName);
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

  setPending(phone, null);
  return {
    reply: `Hey ${firstName(user)}, what can I do for you?`,
    data: { name: user.name, address: user.wallet_address },
  };
}

async function finishNaming(phone: string, rawName: string): Promise<HandleResult> {
  await ensureCaller(phone);
  const user = setUserName(phone, rawName);
  const dep = exportDepositInfo(user);

  if (demoSimple()) {
    if (!user.pin_hash) setPin(phone, hashPin(demoPin()));
    setPending(phone, null);
    return {
      reply: `Nice to meet you, ${firstName(user)}. You're set. What can I do for you?`,
      data: { name: user.name, address: dep.address },
    };
  }

  setPending(phone, null);
  return {
    reply: `Nice to meet you, ${firstName(user)}. Your Arc wallet is ready. Choose a 4-digit PIN on the keypad, then pound.`,
    needsSetPin: true,
    onboarding: true,
    data: { name: user.name, address: dep.address, onboard: true },
  };
}

async function completePinSetup(phone: string, pin: string): Promise<HandleResult> {
  const user = await ensureCaller(phone);
  setPin(phone, hashPin(pin));
  const fresh = getUser(phone)!;
  const dep = exportDepositInfo(fresh);
  setPending(phone, null);

  const reply = fresh.name
    ? `Thanks, ${firstName(fresh)}. You're all set on this number. Call anytime to send USDC to another phone number.`
    : "PIN set. You're ready.";

  void sms
    .send(
      phone,
      `hotline.guru: hi ${firstName(fresh) ?? "there"}. Deposit Arc USDC to ${dep.address}`,
    )
    .catch(() => {});

  return {
    reply,
    onboarding: false,
    data: { name: fresh.name, address: dep.address, onboarded: true },
  };
}

async function dispatch(phone: string, intent: Intent, raw: string): Promise<HandleResult> {
  const awaiting = getPending<PendingName | PendingSend>(phone);

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
      setPending(phone, { type: "awaiting_name" });
      return {
        reply: "First tell me your name, then we'll set your PIN.",
        needsName: true,
        onboarding: true,
      };
    }
    return completePinSetup(phone, intent.pin);
  }

  if (intent.action === "cancel") {
    const pending = getPending<PendingName | PendingSend>(phone);
    if (pending && "type" in pending && pending.type === "awaiting_name") {
      return {
        reply: "Still need your name to finish setup. What's your first name?",
        needsName: true,
        onboarding: true,
      };
    }
    setPending(phone, null);
    return { reply: withName(getUser(phone), "Cancelled.") };
  }

  if (intent.action === "confirm") {
    const pending = getPending<PendingSend>(phone);
    if (!pending || pending.type !== "send") {
      return { reply: "Nothing pending to confirm." };
    }
    const user = await ensureCaller(phone);
    if (!isOnboarded(user)) {
      return continueOnboardOrGreet(phone, user);
    }
    const pin = intent.pin ?? (demoSimple() ? demoPin() : undefined);
    if (!pin) {
      return {
        reply: "Enter your PIN on the keypad, or say yes and your PIN.",
        needsPin: true,
      };
    }
    if (!verifyPin(user, pin)) {
      return { reply: "Wrong PIN. Try again.", needsPin: true };
    }
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
    const fresh = getUser(phone)!;
    return continueOnboardOrGreet(phone, fresh);
  }

  let user = await ensureCaller(phone);

  // Gate everything else behind onboard (name + PIN)
  if (!isOnboarded(user)) {
    if (intent.action === "help" || intent.action === "unknown") {
      return continueOnboardOrGreet(phone, user);
    }
    return continueOnboardOrGreet(phone, user);
  }

  if (intent.action === "help" || intent.action === "unknown") {
    const limits = policyLimits();
    const tip = `Say: send 10 usdt to +15551234567. Soft $${limits.perTx}, hard $${limits.hardCeiling}.`;
    return {
      reply: withName(
        user,
        intent.action === "unknown" ? `I didn't catch that. ${tip}` : tip,
      ),
    };
  }

  if (intent.action === "balance") {
    const bal = await getUsdcBalance(user.wallet_address as Address);
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
    const rows = listContacts(phone) as { contact_name: string; contact_address: string | null }[];
    if (!rows.length) return { reply: withName(user, "No contacts yet.") };
    return {
      reply: withName(
        user,
        rows.map((r) => `${r.contact_name}: ${r.contact_address ?? "?"}`).join("; "),
      ),
    };
  }

  if (intent.action === "history") {
    const rows = listLedger(phone, 5);
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
      saveContact(phone, intent.name, { contactAddress: target });
    } else if (target.startsWith("+") || /^\d+$/.test(target)) {
      saveContact(phone, intent.name, { contactPhone: normalizePhone(target) });
    } else {
      return { reply: "SAVE needs an address (0x…) or phone." };
    }
    return { reply: withName(user, `Saved contact ${intent.name}.`) };
  }

  if (intent.action === "price") {
    const verdict = evaluatePolicy(phone, intent);
    if (verdict.status === "reject") return { reply: withName(user, `Rejected: ${verdict.reason}`) };
    const price = await fetchCryptoPrice(intent.symbol, phone);
    return { reply: withName(user, price.summary), data: { mode: price.mode } };
  }

  if (intent.action === "send") {
    const verdict = evaluatePolicy(phone, intent);
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
    };

    if (demoSimple()) {
      return executeSend(phone, pendingSend, user);
    }

    setPending(phone, pendingSend);
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
  const u = user ?? getUser(phone);
  try {
    const { txHash } = await transferUsdc({
      fromPhone: phone,
      toAddress: pending.toAddress,
      amountUsdc: pending.amount,
    });
    addLedger({
      phone,
      kind: "send",
      amount_usdc: pending.amount,
      counterparty: pending.toPhone ?? pending.toAddress,
      tx_hash: txHash,
    });
    if (pending.toPhone) {
      addLedger({
        phone: pending.toPhone,
        kind: "receive",
        amount_usdc: pending.amount,
        counterparty: phone,
        tx_hash: txHash,
      });
    }
    setPending(phone, null);

    const where =
      pending.toPhone != null
        ? pending.toPhone
        : pending.toLabel.startsWith("+")
          ? pending.toLabel
          : pending.toLabel;
    const provisionNote = pending.provisioned
      ? " Their wallet is ready whenever they call the hotline."
      : "";
    const reply = withName(
      u,
      `Sent ${pending.amount} USDC to ${where}.${provisionNote} Tx ${txHash.slice(0, 12)}…`,
    );
    void sms.send(phone, reply).catch((err) => console.warn("[sms] receipt failed", err));
    if (pending.toPhone) {
      void sms
        .send(
          pending.toPhone,
          `You received ${pending.amount} USDC on Arc via hotline.guru. Call the hotline to claim your number.`,
        )
        .catch(() => {});
    }
    return {
      reply,
      data: {
        txHash,
        to: where,
        toAddress: pending.toAddress,
        provisioned: pending.provisioned ?? false,
      },
    };
  } catch (e) {
    return {
      reply: withName(
        u,
        `Couldn't send: ${e instanceof Error ? e.message : String(e)}. Fund first (faucet or fund-user.sh).`,
      ),
    };
  }
}
