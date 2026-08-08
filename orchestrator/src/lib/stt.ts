import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const STT_URL = () => process.env.STT_URL ?? "http://127.0.0.1:8090";
const SHARED_HOST = () =>
  path.resolve(process.cwd(), process.env.SHARED_DIR ?? "./telephony/shared");
/** Path as seen inside the Asterisk container */
const SHARED_AST = () => process.env.ASTERISK_SHARED ?? "/shared";

export function sharedPaths(id?: string) {
  const fid = id ?? randomBytes(6).toString("hex");
  const hostBase = path.join(SHARED_HOST(), fid);
  const astBase = `${SHARED_AST()}/${fid}`;
  fs.mkdirSync(SHARED_HOST(), { recursive: true });
  return {
    id: fid,
    hostWav: `${hostBase}.wav`,
    astRecordBase: astBase,
  };
}

export async function sttHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${STT_URL()}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Fix common tiny.en / telephony mishears for our send grammar. */
export function normalizeTranscript(raw: string): string {
  let t = raw.toLowerCase();
  t = t.replace(/[_./-]+/g, " ");
  t = t.replace(/[?,!;:]+/g, " ");
  t = t.replace(/\$\s*(\d+(?:\.\d+)?)/g, "$1 dollar");
  t = t.replace(/\b(u\s*s\s*d\s*t|hus|usd\s*t|you\s*s\s*d\s*t)\b/g, "usdt");
  t = t.replace(/\b(u\s*s\s*d\s*c|usd\s*c|u\s*s\s*d\s*see|used\s*see)\b/g, "usdc");
  t = t.replace(/\bplus\b/g, "+");

  // Prefer dollar/euro wording for swaps (STT often butchers "USDC" / "swap" / "euro")
  t = t.replace(/\b(swapped|swop|spot|slap|slop|swat|swap)\b/g, "swap");
  t = t.replace(/\b(trade|trading)\b/g, "exchange");
  t = t.replace(/\beurope\b/g, "euro");
  t = t.replace(/\busdc\b/g, "dollar");
  t = t.replace(/\busdt\b/g, "dollar");
  t = t.replace(/\busd\b/g, "dollar");
  // Whisper: "euro" → era / you / uro / arrow
  t = t.replace(/\bto\s+(era|arrow|uro|yuro|you|your|oreo)\b/g, "to euro");
  t = t.replace(/\bfor\s+(era|arrow|uro|yuro|you|your|oreo)\b/g, "for euro");
  t = t.replace(/\binto\s+(era|arrow|uro|yuro|you|your|oreo)\b/g, "into euro");

  const words: Record<string, string> = {
    zero: "0",
    oh: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    ten: "10",
    eleven: "11",
    twelve: "12",
    twenty: "20",
    thirty: "30",
    forty: "40",
    fifty: "50",
  };
  t = t.replace(
    /\b(zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty)\b/g,
    (m) => words[m] ?? m,
  );

  // "swap 1 dollar 2 euro" (misheard "to") → "swap 1 dollar to euro"
  t = t.replace(
    /\b(dollar|dollars|euro|euros|bitcoin|btc)\s+2\s+(dollar|dollars|euro|euros|bitcoin|btc)\b/g,
    "$1 to $2",
  );

  // "swap 1 to euro" → assume dollars
  t = t.replace(
    /\b(swap|exchange|convert|change)\s+(\d+(?:\.\d+)?)\s+(?:to|for|into)\s+(euro|euros|bitcoin|btc)\b/g,
    "$1 $2 dollar to $3",
  );

  // Bare "1 dollar to euro" (verb dropped by STT) → insert swap
  if (
    /\b\d+(?:\.\d+)?\s+dollars?\s+(?:to|for|into)\s+euros?\b/.test(t) &&
    !/\b(swap|exchange|convert|change)\b/.test(t)
  ) {
    t = t.replace(
      /(\d+(?:\.\d+)?\s+dollars?\s+(?:to|for|into)\s+euros?)/,
      "swap $1",
    );
  }

  // After first "to", scoop all digits into one phone number — but not for FX words
  t = t.replace(/\bto\b([\s\S]*)$/m, (_m, rest: string) => {
    if (/\b(euro|euros|bitcoin|btc|dollar|dollars)\b/i.test(rest)) {
      return ` to${rest}`;
    }
    const digits = String(rest).replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      return ` to +${digits}`;
    }
    return ` to${rest}`;
  });

  return t.replace(/\s+/g, " ").trim();
}

export async function transcribeFile(hostWavPath: string): Promise<{ text: string; duration?: number }> {
  if (!fs.existsSync(hostWavPath)) {
    throw new Error(`recording missing: ${hostWavPath}`);
  }
  const buf = fs.readFileSync(hostWavPath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buf)], { type: "audio/wav" }),
    path.basename(hostWavPath),
  );
  const res = await fetch(`${STT_URL()}/transcribe`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`STT ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { text?: string; duration?: number };
  const text = normalizeTranscript(data.text ?? "");
  return { text, duration: data.duration };
}

export async function synthesizeSpeech(text: string): Promise<{ astStreamBase: string; id: string }> {
  const res = await fetch(`${STT_URL()}/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`TTS ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { path: string; id: string };
  return { astStreamBase: data.path, id: data.id };
}
