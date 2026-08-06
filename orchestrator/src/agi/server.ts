/**
 * FastAGI voice path:
 *   flash/missed → balance SMS
 *   rate → dial-a-rate (no account)
 *   onboard: welcome → name → DTMF PIN → thanks
 *   returning: greet → command → policy → optional memo → DTMF PIN → TTS
 */
import net from "node:net";
import fs from "node:fs";
import {
  attachSendMemo,
  handleCallStart,
  handleDialRate,
  handleMessage,
  handleMissedCall,
  type HandleResult,
} from "../lib/pipeline.js";
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

async function speak(socket: net.Socket, msg: string, voiceOk: boolean) {
  await sayVerbose(socket, msg);
  if (!voiceOk) return;
  try {
    const { astStreamBase } = await synthesizeSpeech(msg);
    await agiCommand(socket, `STREAM FILE ${astStreamBase} "#"`);
  } catch (e) {
    console.warn("[agi] TTS failed", e);
  }
}

async function listen(socket: net.Socket, prompt: string, voiceOk: boolean): Promise<string> {
  if (prompt) await speak(socket, prompt, voiceOk);
  const paths = sharedPaths();
  const rec = await agiCommand(
    socket,
    `RECORD FILE ${paths.astRecordBase} wav # 10000 0 s=2`,
  );
  console.log(`[agi] record ${rec} → ${paths.hostWav}`);

  await new Promise((r) => setTimeout(r, 300));
  if (!fs.existsSync(paths.hostWav)) {
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

/** Collect PIN via keypad — never ask the caller to speak it. */
async function collectPinDigits(
  socket: net.Socket,
  voiceOk: boolean,
  prompt: string | null = "Enter your PIN on the keypad, then pound.",
): Promise<string | null> {
  if (prompt) await speak(socket, prompt, voiceOk);
  const res = await agiCommand(socket, "GET DATA silence/1 20000 6");
  const digits = digitResult(res);
  console.log(`[agi] PIN digits collected: ${digits ? `${digits.length} digits` : "none"}`);
  if (!digits || digits === "0" || digits === "-1") return null;
  if (!/^\d{4,6}$/.test(digits)) return null;
  return digits;
}

async function maybeRecordMemo(
  socket: net.Socket,
  caller: string,
  result: HandleResult,
  voiceOk: boolean,
): Promise<void> {
  if (!result.needsMemo && !result.data?.offerMemo) return;
  if (!voiceOk) return;
  await speak(
    socket,
    "Optional: record a short voice note for them after the beep, or press pound to skip.",
    voiceOk,
  );
  const memo = await listen(socket, "", voiceOk);
  if (memo && memo.length > 2) {
    const attached = await attachSendMemo(caller, memo);
    await speak(socket, attached.reply, voiceOk);
  }
}

/**
 * First-call (or resume) onboard: name → wallet already on phone row → PIN → thanks.
 * Returns true if caller is ready for commands.
 */
async function runOnboarding(
  socket: net.Socket,
  caller: string,
  start: HandleResult,
  voiceOk: boolean,
  forced: string,
): Promise<boolean> {
  let current = start;
  await speak(socket, current.reply, voiceOk);
  lastAgiReply.set(caller, current.reply);

  if (current.needsName) {
    let nameText = "";
    if (forced && !/send|pay|transfer|pin/i.test(forced)) {
      nameText = forced;
    } else if (voiceOk) {
      nameText = await listen(socket, "", voiceOk);
    } else {
      await speak(socket, "Text your name to the hotline SMS, then call again.", voiceOk);
      return false;
    }
    if (!nameText) {
      await speak(socket, "I didn't catch your name. Call back when you're ready.", voiceOk);
      return false;
    }
    current = await handleMessage(caller, nameText);
    await speak(socket, current.reply, voiceOk);
    lastAgiReply.set(caller, current.reply);
  }

  if (current.needsSetPin) {
    const pin = await collectPinDigits(socket, voiceOk, null);
    if (!pin) {
      await speak(socket, "Setup paused. Call back to finish your PIN.", voiceOk);
      return false;
    }
    current = await handleMessage(caller, `PIN ${pin}`);
    await speak(socket, current.reply, voiceOk);
    lastAgiReply.set(caller, current.reply);
  }

  return !current.needsName && !current.needsSetPin;
}

async function finishSpendPin(
  socket: net.Socket,
  caller: string,
  result: HandleResult,
  voiceOk: boolean,
): Promise<HandleResult> {
  let current = result;
  await speak(socket, current.reply, voiceOk);
  lastAgiReply.set(caller, current.reply);

  await maybeRecordMemo(socket, caller, current, voiceOk);

  for (let attempt = 0; attempt < 2 && current.needsPin; attempt++) {
    const pin = await collectPinDigits(
      socket,
      voiceOk,
      attempt === 0
        ? "Enter your PIN, then pound."
        : "Wrong PIN. Try once more, then pound.",
    );
    if (!pin) {
      await handleMessage(caller, "cancel");
      await speak(socket, "Cancelled.", voiceOk);
      lastAgiReply.set(caller, "Cancelled.");
      return { reply: "Cancelled." };
    }
    current = await handleMessage(caller, `CONFIRM ${pin}`);
    await speak(socket, current.reply, voiceOk);
    lastAgiReply.set(caller, current.reply);
    if (!current.needsPin) break;
  }

  if (current.needsPin) {
    await handleMessage(caller, "cancel");
    await speak(socket, "Too many wrong PINs. Send cancelled.", voiceOk);
    lastAgiReply.set(caller, "Too many wrong PINs. Send cancelled.");
    return { reply: "Too many wrong PINs. Send cancelled." };
  }

  return current;
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
  if (result.needsPin) {
    await finishSpendPin(socket, caller, result, voiceOk);
  } else {
    await speak(socket, result.reply, voiceOk);
    lastAgiReply.set(caller, result.reply);
  }
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
  console.log(`[agi] call from ${caller.replace(/\d(?=\d{4})/g, "*")}`);

  const voiceOk = await sttHealthy();
  console.log(`[agi] STT ${voiceOk ? "up" : "down — DTMF fallback"}`);

  const forced = (env["agi_arg_1"] || "").trim().toLowerCase();

  // Missed call / flash → balance SMS, hang up
  if (forced === "missed" || forced === "flash") {
    const flash = await handleMissedCall(caller);
    await speak(socket, "Balance by text. Bye.", voiceOk);
    lastAgiReply.set(caller, flash.reply);
    await agiCommand(socket, "HANGUP");
    socket.end();
    return;
  }

  // Dial-a-rate — no account
  if (forced === "rate" || forced === "dial-rate" || forced === "dialrate") {
    const rate = await handleDialRate(caller);
    await speak(socket, rate.reply, voiceOk);
    lastAgiReply.set(caller, rate.reply);
    await agiCommand(socket, "HANGUP");
    socket.end();
    return;
  }

  const start = await handleCallStart(caller);

  if (start.needsName || start.needsSetPin || start.onboarding) {
    const ready = await runOnboarding(socket, caller, start, voiceOk, forced);
    if (!ready) {
      await agiCommand(socket, "HANGUP");
      socket.end();
      return;
    }
  } else {
    await speak(socket, start.reply, voiceOk);
    lastAgiReply.set(caller, start.reply);
  }

  let text: string;
  if (forced && /send|pay|transfer|balance|history|help|policy|rate|lock|standing/i.test(forced)) {
    text = env["agi_arg_1"] || forced;
  } else if (voiceOk) {
    text = await listen(
      socket,
      "What can I do for you? Send money, set a rule, standing order, or ask the rate.",
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
  if (result.needsPin) {
    await finishSpendPin(socket, caller, result, voiceOk);
  } else if (result.needsSetPin || result.needsName) {
    await runOnboarding(socket, caller, result, voiceOk, "");
  } else {
    await speak(socket, result.reply, voiceOk);
    lastAgiReply.set(caller, result.reply);
  }

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
  const host = process.env.AGI_BIND ?? "0.0.0.0";
  server.listen(port, host, () => {
    console.log(`hotline.guru FastAGI on ${host}:${port}`);
  });
  return server;
}
