/**
 * Spoken policy → deterministic frozen rules.
 * LLM (or regex compiler) proposes; user confirms; evaluatePolicy enforces.
 * Rules only tighten — never raise hard ceiling / system caps.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  getActiveUserRules,
  insertUserRule,
  normalizePhone,
  revokeUserRules,
  sumLedgerKindToCounterparty,
} from "./db.js";

export type FrozenRule = {
  id: string;
  kind: "max_new_payee_usdc" | "max_per_tx_usdc" | "deny_label";
  maxUsdc?: number;
  label?: string;
  spoken: string;
  readback: string;
};

const WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

function parseAmountToken(tok: string): number | null {
  const t = tok.toLowerCase().replace(/,/g, "");
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return WORDS[t] ?? null;
}

/** Deterministic compiler — covers the demo sentence and common tighteners. */
export function compilePolicyRules(spoken: string): FrozenRule[] | null {
  const t = spoken.trim().replace(/^policy\s*:?\s*/i, "").replace(/^rule\s*:?\s*/i, "");
  if (!t) return null;

  const newPayee =
    /never\s+send\s+more\s+than\s+(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred)\s*(?:dollars?|usdc|usdt|bucks?)?\s+to\s+(?:someone\s+)?(?:i\s+haven'?t\s+paid\s+before|new\s+(?:people|contacts|payees)|strangers?)/i.exec(
      t,
    );
  if (newPayee) {
    const maxUsdc = parseAmountToken(newPayee[1]!);
    if (maxUsdc == null || !(maxUsdc > 0)) return null;
    return [
      {
        id: randomUUID(),
        kind: "max_new_payee_usdc",
        maxUsdc,
        spoken: t,
        readback: `Never send more than $${maxUsdc} to someone you haven't paid before.`,
      },
    ];
  }

  const maxAny =
    /never\s+send\s+more\s+than\s+(\d+(?:\.\d+)?|ten|twenty|fifty|hundred)\s*(?:dollars?|usdc|usdt)?(?:\s|$)/i.exec(
      t,
    );
  if (maxAny) {
    const maxUsdc = parseAmountToken(maxAny[1]!);
    if (maxUsdc == null || !(maxUsdc > 0)) return null;
    return [
      {
        id: randomUUID(),
        kind: "max_per_tx_usdc",
        maxUsdc,
        spoken: t,
        readback: `Never send more than $${maxUsdc} in one transfer.`,
      },
    ];
  }

  const deny =
    /(?:never|don'?t|do\s+not)\s+send\s+to\s+([+\d][\d\s().-]{6,}|[a-z][a-z0-9.-]{1,40})/i.exec(t);
  if (deny) {
    const label = deny[1]!.trim().toLowerCase();
    return [
      {
        id: randomUUID(),
        kind: "deny_label",
        label,
        spoken: t,
        readback: `Never send to ${label}.`,
      },
    ];
  }

  return null;
}

/** Optional LLM compile — must return JSON array of rules; still requires user confirm. */
export async function compilePolicySmart(spoken: string): Promise<FrozenRule[] | null> {
  const local = compilePolicyRules(spoken);
  if (local) return local;

  if (process.env.INTENT_MODE !== "openai" || !process.env.OPENAI_API_KEY) {
    return null;
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'Compile spoken money rules to JSON {"rules":[{"kind":"max_new_payee_usdc"|"max_per_tx_usdc"|"deny_label","maxUsdc"?:number,"label"?:string,"readback":string}]}. Only tighten. Empty rules if unclear.',
          },
          { role: "user", content: spoken },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      rules?: { kind: string; maxUsdc?: number; label?: string; readback?: string }[];
    };
    if (!parsed.rules?.length) return null;
    return parsed.rules
      .filter((r) =>
        ["max_new_payee_usdc", "max_per_tx_usdc", "deny_label"].includes(r.kind),
      )
      .map((r) => ({
        id: randomUUID(),
        kind: r.kind as FrozenRule["kind"],
        maxUsdc: r.maxUsdc,
        label: r.label,
        spoken,
        readback: r.readback ?? describeRule(r as FrozenRule),
      }));
  } catch {
    return null;
  }
}

export function describeRule(r: FrozenRule): string {
  if (r.readback) return r.readback;
  if (r.kind === "max_new_payee_usdc") {
    return `Never send more than $${r.maxUsdc} to someone you haven't paid before.`;
  }
  if (r.kind === "max_per_tx_usdc") {
    return `Never send more than $${r.maxUsdc} in one transfer.`;
  }
  return `Never send to ${r.label}.`;
}

export function describeRules(rules: FrozenRule[]): string {
  return rules.map(describeRule).join(" ");
}

export async function freezeRules(phone: string, rules: FrozenRule[]): Promise<void> {
  const p = normalizePhone(phone);
  for (const r of rules) {
    await insertUserRule({
      phone: p,
      rule_id: r.id,
      kind: r.kind,
      max_usdc: r.maxUsdc ?? null,
      label: r.label ?? null,
      spoken: r.spoken,
      readback: r.readback,
      rules_hash: hashRules([r]),
    });
  }
}

export async function clearFrozenRules(phone: string): Promise<void> {
  await revokeUserRules(normalizePhone(phone));
}

export async function loadFrozenRules(phone: string): Promise<FrozenRule[]> {
  const rows = await getActiveUserRules(normalizePhone(phone));
  return rows.map((r) => ({
    id: r.rule_id,
    kind: r.kind as FrozenRule["kind"],
    maxUsdc: r.max_usdc ?? undefined,
    label: r.label ?? undefined,
    spoken: r.spoken,
    readback: r.readback,
  }));
}

export function hashRules(rules: FrozenRule[]): string {
  return createHash("sha256").update(JSON.stringify(rules)).digest("hex").slice(0, 16);
}

/** True if this phone has a prior send/escrow to this counterparty. */
export async function hasPaidBefore(fromPhone: string, counterparty: string): Promise<boolean> {
  const n = await sumLedgerKindToCounterparty(fromPhone, counterparty, ["send", "escrow_hold"]);
  return n > 0;
}

export async function applyUserRules(opts: {
  phone: string;
  amount: number;
  payeeLabel: string;
  payeePhone?: string | null;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const rules = await loadFrozenRules(opts.phone);
  if (!rules.length) return { ok: true };

  const counterparty = opts.payeePhone ?? opts.payeeLabel;
  const paid = await hasPaidBefore(opts.phone, counterparty);

  for (const r of rules) {
    if (r.kind === "deny_label") {
      const lab = (r.label ?? "").toLowerCase();
      if (
        lab &&
        (opts.payeeLabel.toLowerCase().includes(lab) ||
          (opts.payeePhone && opts.payeePhone.includes(lab.replace(/\D/g, ""))))
      ) {
        return { ok: false, reason: `Your rule: ${describeRule(r)}` };
      }
    }
    if (r.kind === "max_per_tx_usdc" && r.maxUsdc != null && opts.amount > r.maxUsdc) {
      return { ok: false, reason: `Your rule: ${describeRule(r)}` };
    }
    if (
      r.kind === "max_new_payee_usdc" &&
      r.maxUsdc != null &&
      !paid &&
      opts.amount > r.maxUsdc
    ) {
      return { ok: false, reason: `Your rule: ${describeRule(r)}` };
    }
  }
  return { ok: true };
}
