import { createHash } from "node:crypto";

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: "hotline.guru",
    msg,
    ...fields,
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
