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
  t = t.replace(/\b(u\s*s\s*d\s*t|hus|usd\s*t|you\s*s\s*d\s*t)\b/g, "usdt");
  t = t.replace(/\b(u\s*s\s*d\s*c|usd\s*c)\b/g, "usdc");
  t = t.replace(/\bplus\b/g, "+");

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

  // After first "to", scoop all digits into one phone number
  t = t.replace(/\bto\b([\s\S]*)$/m, (_m, rest: string) => {
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
