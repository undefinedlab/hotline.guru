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

/** Asterisk WAIT FOR DIGIT → character, or null on timeout. */
function waitDigitChar(line: string): string | null {
  const raw = digitResult(line);
  if (!raw || raw === "0" || raw === "-1") return null;
  const code = Number(raw);
  if (!Number.isFinite(code) || code <= 0) return null;
  return String.fromCharCode(code);
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
    // Empty escape set: don't let early DTMF abort the prompt (drops PIN digits).
    await agiCommand(socket, `STREAM FILE ${astStreamBase} ""`);
  } catch (e) {
    console.warn("[agi] TTS failed", e);
  }
}

async function listen(socket: net.Socket, prompt: string, voiceOk: boolean): Promise<string> {
  if (prompt) await speak(socket, prompt, voiceOk);
  // Pause so the user can start speaking before we open the recorder.
  await agiCommand(socket, "EXEC Wait 1");
  await agiCommand(socket, "EXEC Playtones 400/300");
  await agiCommand(socket, "EXEC Wait 0.35");
  await agiCommand(socket, "EXEC StopPlaytones");
  const paths = sharedPaths();
  // Up to 12s; end after ~5s of silence once speech started.
  const rec = await agiCommand(
    socket,
    `RECORD FILE ${paths.astRecordBase} wav # 12000 0 s=5`,
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

/**
 * Collect PIN via WAIT FOR DIGIT — does not need silence/ sound files.
 * (GET DATA silence/1 was failing instantly: file missing → result=-1.)
 */
async function collectPinDigits(
  socket: net.Socket,
  voiceOk: boolean,
  prompt: string | null = "Enter your 4 digit PIN on the keypad, then pound.",
): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const say =
      attempt === 0
        ? (prompt ?? "Enter your 4 digit PIN on the keypad, then pound.")
        : "I did not get four digits. Enter your PIN on the keypad, then pound.";
    await speak(socket, say, voiceOk);
    await agiCommand(socket, "EXEC Wait 1");

    let collected = "";
    const first = waitDigitChar(await agiCommand(socket, "WAIT FOR DIGIT 5000"));
    if (!first) {
      console.log(`[agi] PIN: no digit in 5s attempt=${attempt + 1}`);
      continue;
    }
    if (first === "#") continue;
    if (first < "0" || first > "9") continue;
    collected = first;

    while (collected.length < 4) {
      const next = waitDigitChar(await agiCommand(socket, "WAIT FOR DIGIT 5000"));
      if (!next) {
        console.log(`[agi] PIN: timeout after ${collected.length} digits attempt=${attempt + 1}`);
        break;
      }
      if (next === "#") break;
      if (next >= "0" && next <= "9") collected += next;
    }

    console.log(`[agi] PIN digits: ${collected.length} attempt=${attempt + 1}`);
    if (/^\d{4}$/.test(collected)) return collected;
  }
  return null;
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
    if (forced && !/send|pay|transfer|swap|exchange|convert|pin/i.test(forced)) {
      nameText = forced;
    } else if (voiceOk) {
      for (let attempt = 0; attempt < 3 && !nameText; attempt++) {
        const prompt =
          attempt === 0
            ? ""
            : attempt === 1
              ? "Sorry, say your first name again after the beep."
              : "One more try — say your first name clearly after the beep.";
        nameText = await listen(socket, prompt, voiceOk);
      }
    } else {
      await speak(socket, "Text your name to the hotline SMS, then call again.", voiceOk);
      return false;
    }
    if (!nameText) {
      await speak(
        socket,
        "I still can't hear you. Continuing as Guest — you can change your name later by text.",
        voiceOk,
      );
      nameText = "Guest";
    }
    current = await handleMessage(caller, nameText);
    await speak(socket, current.reply, voiceOk);
    lastAgiReply.set(caller, current.reply);
  }

  if (current.needsSetPin) {
    const pin = await collectPinDigits(
      socket,
      voiceOk,
      "Enter four digits on the keypad for your PIN, then pound.",
    );
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
  // Confirm once (no "enter PIN" in the text) — then collect digits once.
  await speak(socket, current.spoken ?? current.reply, voiceOk);
  lastAgiReply.set(caller, current.spoken ?? current.reply);

  await maybeRecordMemo(socket, caller, current, voiceOk);

  for (let attempt = 0; attempt < 2 && current.needsPin; attempt++) {
    const pin = await collectPinDigits(
      socket,
      voiceOk,
      attempt === 0
        ? "Enter your PIN on the keypad, then pound."
        : "Wrong PIN. Try once more, then pound.",
    );
    if (!pin) {
      await handleMessage(caller, "cancel");
      await speak(socket, "Cancelled.", voiceOk);
      lastAgiReply.set(caller, "Cancelled.");
      return { reply: "Cancelled." };
    }
    current = await handleMessage(caller, `CONFIRM ${pin}`);
    await speak(socket, current.spoken ?? current.reply, voiceOk);
    lastAgiReply.set(caller, current.spoken ?? current.reply);
    if (!current.needsPin) break;
  }

  if (current.needsPin) {
    await handleMessage(caller, "cancel");
    await speak(socket, "Too many wrong PINs. Cancelled.", voiceOk);
    lastAgiReply.set(caller, "Too many wrong PINs. Cancelled.");
    return { reply: "Too many wrong PINs. Cancelled." };
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
    await speak(socket, result.spoken ?? result.reply, voiceOk);
    lastAgiReply.set(caller, result.spoken ?? result.reply);
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
  // Extra settle so the opening sentence is not clipped on PSTN.
  await agiCommand(socket, "EXEC Wait 0.5");

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
  if (forced && /send|pay|transfer|swap|exchange|convert|balance|history|help|policy|rate|lock|standing/i.test(forced)) {
    text = env["agi_arg_1"] || forced;
    const result = await handleMessage(caller, text);
    if (result.needsPin) {
      await finishSpendPin(socket, caller, result, voiceOk);
    } else if (result.needsSetPin || result.needsName) {
      await runOnboarding(socket, caller, result, voiceOk, "");
    } else {
      await speak(socket, result.spoken ?? result.reply, voiceOk);
      lastAgiReply.set(caller, result.spoken ?? result.reply);
    }
  } else if (voiceOk) {
    // Greeting already asked "what can I do for you?" — first turn is beep-only listen.
    for (let turn = 0; turn < 5; turn++) {
      const prompt = turn === 0 ? "" : "Anything else? Or say goodbye.";
      text = await listen(socket, prompt, voiceOk);
      if (!text) {
        if (turn === 0) {
          await speak(
            socket,
            "I didn't catch that. Try saying exchange one dollar to euro.",
            voiceOk,
          );
          continue;
        }
        await speak(socket, "Alright, call anytime.", voiceOk);
        break;
      }
      if (/^(bye|goodbye|hang\s*up|that's\s*all|nothing|no)\b/i.test(text)) {
        await speak(socket, "Goodbye.", voiceOk);
        break;
      }
      const result = await handleMessage(caller, text);
      if (result.needsPin) {
        await finishSpendPin(socket, caller, result, voiceOk);
      } else if (result.needsSetPin || result.needsName) {
        await runOnboarding(socket, caller, result, voiceOk, "");
      } else {
        await speak(socket, result.spoken ?? result.reply, voiceOk);
        lastAgiReply.set(caller, result.spoken ?? result.reply);
      }
    }
  } else {
    await dtmfFallback(socket, caller, voiceOk);
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
