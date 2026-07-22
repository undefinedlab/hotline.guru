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

function demoSimple(): boolean {
  return (process.env.DEMO_SIMPLE ?? "1") !== "0";
}

function demoPin(): string {
  return process.env.DEMO_PIN ?? "1234";
}

export type HandleResult = {
  reply: string;
  data?: Record<string, unknown>;
  needsName?: boolean;
};

type PendingSend = {
  type: "send";
  amount: number;
  toLabel: string;
  toAddress: Address;
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

export async function handleMessage(phoneRaw: string, text: string): Promise<HandleResult> {
  const phone = normalizePhone(phoneRaw);
  const intent = await parseIntentSmart(text);
  return dispatch(phone, intent, text);
}

/** Pickup / SMS open — greet returning users or ask for a name. */
export async function handleCallStart(phoneRaw: string): Promise<HandleResult> {
  const phone = normalizePhone(phoneRaw);
  const user = await ensureCaller(phone);
  return greetOrAskName(phone, user);
}

async function ensureCaller(phone: string) {
  let user = getUser(phone);
  if (!user) {
    user = await ensureWallet(phone);
  }
  if (demoSimple() && !user.pin_hash) {
    setPin(phone, hashPin(demoPin()));
    user = getUser(phone)!;
  }
  return user;
}

async function greetOrAskName(phone: string, user: User): Promise<HandleResult> {
  if (!user.name) {
    setPending(phone, { type: "awaiting_name" } satisfies PendingName);
    return {
      reply: "Hey — first time calling. What's your name?",
      needsName: true,
      data: { onboard: true },
    };
  }
  setPending(phone, null);
  return {
    reply: `Hey ${firstName(user)}, what can I do for you?`,
    data: { name: user.name },
  };
}

async function finishNaming(phone: string, rawName: string): Promise<HandleResult> {
  await ensureCaller(phone);
  const user = setUserName(phone, rawName);
  setPending(phone, null);
  return {
    reply: `Nice to meet you, ${firstName(user)}. What can I do for you? You can say: send 10 usdt to a phone number.`,
    data: { name: user.name },
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
    };
  }

  if (intent.action === "set_name") {
    await ensureCaller(phone);
    const updated = setUserName(phone, intent.name);
    return {
      reply: `Got it, ${firstName(updated)}. What can I do for you?`,
      data: { name: updated.name },
    };
  }

  if (intent.action === "hello") {
    const user = await ensureCaller(phone);
    return greetOrAskName(phone, user);
  }

  if (intent.action === "help" || intent.action === "unknown") {
    const user = getUser(phone);
    const limits = policyLimits();
    const tip = `Say: send 10 usdt to +15551234567. Soft $${limits.perTx}, hard $${limits.hardCeiling}.`;
    return {
      reply: withName(
        user,
        intent.action === "unknown" ? `I didn't catch that. ${tip}` : tip,
      ),
    };
  }

  if (intent.action === "cancel") {
    setPending(phone, null);
    return { reply: withName(getUser(phone), "Cancelled.") };
  }

  if (intent.action === "confirm") {
    const pending = getPending<PendingSend>(phone);
    if (!pending || pending.type !== "send") {
      return { reply: "Nothing pending to confirm." };
    }
    const user = await ensureCaller(phone);
    const pin = intent.pin ?? (demoSimple() ? demoPin() : undefined);
    if (!pin) return { reply: "Say yes and your PIN, e.g. yes 1234" };
    if (!verifyPin(user, pin)) return { reply: "Wrong PIN." };
    return executeSend(phone, pending, user);
  }

  if (intent.action === "join") {
    await ensureWallet(phone, intent.name);
    let fraudNote = "";
    if (process.env.FRAUD_CHECK_ON_JOIN === "1") {
      const fraud = await phoneFraudLookup(phone);
      fraudNote = ` ${fraud.summary}.`;
    }
    if (demoSimple()) {
      const u = getUser(phone)!;
      if (!u.pin_hash) setPin(phone, hashPin(demoPin()));
    }
    if (intent.name) setUserName(phone, intent.name);
    const fresh = getUser(phone)!;
    if (!fresh.name) return greetOrAskName(phone, fresh);
    const dep = exportDepositInfo(fresh);
    return {
      reply: `Hey ${firstName(fresh)}, you're set. What can I do for you? Wallet ${dep.address}.${fraudNote}`,
      data: { address: dep.address },
    };
  }

  if (intent.action === "set_pin") {
    const user = await ensureCaller(phone);
    setPin(phone, hashPin(intent.pin));
    return { reply: withName(user, "PIN set.") };
  }

  let user = await ensureCaller(phone);

  // First-time: ask name before send (and most other actions)
  if (!user.name && intent.action === "send") {
    setPending(phone, { type: "awaiting_name" });
    return {
      reply: "Before we send money — what's your name?",
      needsName: true,
    };
  }
  if (!user.name) {
    return greetOrAskName(phone, user);
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
        reply: withName(user, `I don't know "${intent.to}". Use a phone number like +15551234567.`),
      };
    }
    const pendingSend: PendingSend = {
      type: "send",
      amount: intent.amount,
      toLabel: payee.label,
      toAddress: payee.address,
    };

    if (demoSimple() && verdict.status !== "reject") {
      return executeSend(phone, pendingSend, user);
    }

    setPending(phone, pendingSend);
    return {
      reply: withName(
        user,
        `Confirm send ${intent.amount} USDC to ${payee.label}? Say yes ${demoPin()}.`,
      ),
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
      counterparty: pending.toAddress,
      tx_hash: txHash,
    });
    setPending(phone, null);
    const reply = withName(
      u,
      `Sent ${pending.amount} USDC to ${pending.toLabel}. Tx ${txHash.slice(0, 12)}… https://testnet.arcscan.app/tx/${txHash}`,
    );
    void sms.send(phone, reply).catch((err) => console.warn("[sms] receipt failed", err));
    if (pending.toLabel.startsWith("+")) {
      void sms.send(pending.toLabel, `You received ${pending.amount} USDC on Arc.`).catch(() => {});
    }
    return { reply, data: { txHash } };
  } catch (e) {
    return {
      reply: withName(
        u,
        `Couldn't send: ${e instanceof Error ? e.message : String(e)}. Fund first (faucet or fund-user.sh).`,
      ),
    };
  }
}
