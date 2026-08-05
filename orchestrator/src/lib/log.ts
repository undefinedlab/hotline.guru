import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

type Level = "debug" | "info" | "warn" | "error";

const SENSITIVE_KEYS = /^(phone|from|to|account|caller|chatid|username|name|displayname|national.?id|pin|secret|token|password|authorization)$/i;

function scrubValue(key: string, value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (SENSITIVE_KEYS.test(key) || key.toLowerCase().includes("phone")) {
      return shortHash(value);
    }
    return redactSecrets(value);
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return scrubFields(value as Record<string, unknown>);
  }
  return value;
}

function scrubFields(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = scrubValue(k, v);
  }
  return out;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: "hotline.guru",
    msg: redactSecrets(msg),
    ...scrubFields(fields),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

/** Redact PIN-like digit runs in logs. */
export function redactSecrets(text: string): string {
  return text.replace(/\b\d{4,6}\b/g, "****");
}

export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** Constant-time string compare (pads to equal length via hashes). */
export function safeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export { randomBytes, scryptSync, timingSafeEqual };
