/**
 * FastAGI voice path:
 *   greet → (record name if needed) → record command → faster-whisper → pipeline → espeak TTS
 * Falls back to DTMF if STT is down.
 */
import net from "node:net";
import fs from "node:fs";
import { handleCallStart, handleMessage } from "../lib/pipeline.js";
import {
  sharedPaths,
  sttHealthy,
  synthesizeSpeech,
  transcribeFile,
} from "../lib/stt.js";

type AgiEnv = Record<string, string>;

async function readLine(socket: net.Socket): Promise<string | null> {
  return new Promise((resolve) => {
    const onData = (buf: Buffer) => {
      socket.off("data", onData);
      resolve(buf.toString("utf8"));
    };
    socket.on("data", onData);
    socket.on("close", () => resolve(null));
  });
}

async function agiCommand(socket: net.Socket, cmd: string): Promise<string> {
  socket.write(cmd + "\n");
  let acc = "";
  for (;;) {
    const chunk = await readLine(socket);
    if (chunk == null) return acc;
    acc += chunk;
    if (acc.includes("\n")) return acc.trim();
  }
}

function parseEnv(block: string): AgiEnv {
  const env: AgiEnv = {};
  for (const line of block.split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

function digitResult(line: string): string {
  return line.match(/result=(-?\d+)/)?.[1] ?? "";
}

async function sayVerbose(socket: net.Socket, msg: string) {
  const safe = msg.replace(/"/g, "'").slice(0, 200);
  await agiCommand(socket, `VERBOSE "${safe}" 1`);
}

/** Speak via espeak TTS into the call; always VERBOSE as backup. */
async function speak(socket: net.Socket, msg: string, voiceOk: boolean) {
  await sayVerbose(socket, msg);
  if (!voiceOk) return;
  try {
    const { astStreamBase } = await synthesizeSpeech(msg);
    // STREAM FILE <path-without-ext> escape_digits
    await agiCommand(socket, `STREAM FILE ${astStreamBase} "#"`);
  } catch (e) {
    console.warn("[agi] TTS failed", e);
  }
}

/** Record caller utterance → faster-whisper text. */
async function listen(socket: net.Socket, prompt: string, voiceOk: boolean): Promise<string> {
  await speak(socket, prompt, voiceOk);
  const paths = sharedPaths();
  // RECORD FILE filename format escape timeout beep s=silence
  // 10s max, end on #, 2s silence
  const rec = await agiCommand(
    socket,
    `RECORD FILE ${paths.astRecordBase} wav # 10000 0 s=2`,
  );
  console.log(`[agi] record ${rec} → ${paths.hostWav}`);

  // Brief wait for filesystem flush from container volume
  await new Promise((r) => setTimeout(r, 300));
  if (!fs.existsSync(paths.hostWav)) {
    // try gsm fallback
    const gsm = paths.hostWav.replace(/\.wav$/, ".gsm");
    if (fs.existsSync(gsm)) {
      console.warn("[agi] got gsm not wav — STT expects wav");
    }
    return "";
  }
  const { text } = await transcribeFile(paths.hostWav);
  console.log(`[agi] heard: "${text}"`);
  return text;
}

async function dtmfFallback(socket: net.Socket, caller: string, voiceOk: boolean) {
  await speak(socket, "Voice offline. Enter amount then pound.", voiceOk);
  const amtRes = await agiCommand(socket, "GET DATA silence/1 10000 6");
  const amount = digitResult(amtRes);
  if (!amount || amount === "0" || amount === "-1") {
    await speak(socket, "Alright, call anytime.", voiceOk);
    return;
  }
  await speak(socket, "Enter phone number then pound.", voiceOk);
  const phoneRes = await agiCommand(socket, "GET DATA silence/1 15000 15");
  const digits = digitResult(phoneRes);
  if (!digits || digits === "0" || digits === "-1") {
    await speak(socket, "Cancelled.", voiceOk);
    return;
  }
  const to = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  const text = `send ${amount} usdt to ${to}`;
  const result = await handleMessage(caller, text);
  await speak(socket, result.reply, voiceOk);
  lastAgiReply.set(caller, result.reply);
}

async function handleAgi(socket: net.Socket) {
  let header = "";
  for (;;) {
    const line = await readLine(socket);
    if (line == null) return;
    header += line;
    if (header.includes("\n\n")) break;
  }
  const env = parseEnv(header);
  const caller = env["agi_callerid"] || env["agi_accountcode"] || "+10000000000";
  console.log(`[agi] call from ${caller}`);

  const voiceOk = await sttHealthy();
  console.log(`[agi] STT ${voiceOk ? "up" : "down — DTMF fallback"}`);

  // Forced text from dialplan still works: AGI(...,"send 10 usdt to +1...")
  const forced = (env["agi_arg_1"] || "").trim();

  const start = await handleCallStart(caller);
  await speak(socket, start.reply, voiceOk);
  lastAgiReply.set(caller, start.reply);

  if (start.needsName) {
    if (forced && !/send|pay|transfer/i.test(forced)) {
      const named = await handleMessage(caller, forced);
      await speak(socket, named.reply, voiceOk);
      lastAgiReply.set(caller, named.reply);
    } else if (voiceOk) {
      const nameHeard = await listen(socket, "Please say your first name.", voiceOk);
      if (!nameHeard) {
        await speak(socket, "I didn't catch your name. Try again later.", voiceOk);
        await agiCommand(socket, "HANGUP");
        socket.end();
        return;
      }
      const named = await handleMessage(caller, nameHeard);
      await speak(socket, named.reply, voiceOk);
      lastAgiReply.set(caller, named.reply);
    } else {
      await speak(socket, "Text your name to the hotline SMS, then call again.", voiceOk);
      await agiCommand(socket, "HANGUP");
      socket.end();
      return;
    }
  }

  let text: string;
  if (forced && /send|pay|transfer|balance|history|help/i.test(forced)) {
    text = forced;
  } else if (voiceOk) {
    text = await listen(
      socket,
      "What can I do for you? For example, say: send 10 USDT to a phone number.",
      voiceOk,
    );
    if (!text) {
      await speak(socket, "I didn't catch that. Try the keypad.", voiceOk);
      await dtmfFallback(socket, caller, voiceOk);
      await agiCommand(socket, "HANGUP");
      socket.end();
      return;
    }
  } else {
    await dtmfFallback(socket, caller, voiceOk);
    await agiCommand(socket, "HANGUP");
    socket.end();
    return;
  }

  const result = await handleMessage(caller, text);
  await speak(socket, result.reply, voiceOk);
  lastAgiReply.set(caller, result.reply);
  await agiCommand(socket, "HANGUP");
  socket.end();
}

export const lastAgiReply = new Map<string, string>();

export function startAgiServer(port: number) {
  const server = net.createServer((socket) => {
    handleAgi(socket).catch((err) => {
      console.error("[agi] error", err);
      socket.destroy();
    });
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`hotline.guru FastAGI on :${port}`);
  });
  return server;
}
