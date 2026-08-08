import { loadEnv } from "./lib/env.js";
loadEnv();

import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { handleCallStart, handleMessage, type HandleResult } from "./lib/pipeline.js";
import { createSmsProvider, handleInboundSms } from "./lib/sms.js";
import { lastAgiReply, startAgiServer } from "./agi/server.js";
import { checkDb, initDb, listPolicyAudit, normalizePhone } from "./lib/db.js";
import { checkArcRpc, resolveWalletMode } from "./lib/wallets.js";
import { circleConfigured, circleGasStationEnabled, circleHealth } from "./lib/circle.js";
import { sttHealthy } from "./lib/stt.js";
import { log, safeEqualStr } from "./lib/log.js";
import { verifyAtWebhook, verifyGenericHmac, verifyTelnyxSignature } from "./lib/webhooks.js";
import {
  assertProfileConfig,
  channelStatus,
  hotlineProfile,
  labApiAuthorized,
  labHttpApiAllowed,
} from "./lib/profile.js";
import { ingressRateLimit } from "./lib/rateLimit.js";
import { startWorkers } from "./lib/workers.js";
import { callerText, textForPipeline, twiml, verifyTwilioSignature } from "./lib/twilio.js";
import {
  createWhatsAppProvider,
  parseWhatsAppWebhook,
  verifyWhatsAppSignature,
  whatsappVerifyChallenge,
} from "./lib/whatsapp.js";
import {
  createTelegramProvider,
  parseTelegramUpdate,
  verifyTelegramSecret,
} from "./lib/telegram.js";
import { handleInboundTelegram, handleInboundWhatsApp } from "./lib/ingress.js";

const app = new Hono();
const sms = createSmsProvider();
const whatsapp = createWhatsAppProvider();
const telegram = createTelegramProvider();

function rateLimited(
  c: { json: (b: unknown, statusOrInit?: number | { status?: number; headers?: Record<string, string> }) => Response },
  account: string,
) {
  const rl = ingressRateLimit(account);
  if (!rl.ok) {
    return c.json(
      { error: "rate limit", retryAfterSec: rl.retryAfterSec },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } },
    );
  }
  return null;
}

function auditAuthorized(c: { req: { header: (n: string) => string | undefined } }): boolean {
  const expected = process.env.AUDIT_EXPORT_TOKEN;
  if (!expected) {
    return hotlineProfile() === "lab" && process.env.WEBHOOK_VERIFY !== "1";
  }
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const headerTok = c.req.header("x-audit-token") ?? "";
  return (
    (Boolean(bearer) && safeEqualStr(bearer, expected)) ||
    (Boolean(headerTok) && safeEqualStr(headerTok, expected))
  );
}

function requireLabHttp(
  c: {
    req: { header: (n: string) => string | undefined };
    json: (b: unknown, s?: number) => Response;
  },
): Response | null {
  if (!labHttpApiAllowed()) {
    return c.json({ error: "lab http api disabled — use verified channel webhooks" }, 403);
  }
  if (
    !labApiAuthorized(c.req.header("authorization"), c.req.header("x-lab-token"))
  ) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return null;
}

app.get("/health", async (c) => {
  const deep = c.req.query("deep") === "1" || c.req.query("deep") === "true";
  const base = {
    ok: true,
    service: "hotline.guru",
    profile: hotlineProfile(),
    walletMode: resolveWalletMode(),
    sms: sms.name,
    whatsapp: whatsapp.name,
    telegram: telegram.name,
    circleConfigured: circleConfigured(),
    gasStation: circleGasStationEnabled(),
  };
  if (!deep) return c.json(base);

  // Deep checks — require audit token outside open lab
  if (process.env.AUDIT_EXPORT_TOKEN || hotlineProfile() !== "lab") {
    if (!auditAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  }

  const mode = resolveWalletMode();
  const [db, arc, stt, circle] = await Promise.all([
    checkDb(),
    checkArcRpc(),
    sttHealthy(),
    mode === "circle" ? circleHealth() : Promise.resolve({ ok: true as const }),
  ]);
  const ok = db.ok && arc.ok && (mode !== "circle" || circle.ok);
  return c.json(
    {
      ...base,
      ok,
      channels: channelStatus(),
      checks: {
        db,
        arc,
        stt: { ok: stt },
        circle,
      },
    },
    ok ? 200 : 503,
  );
});

app.get("/v1/audit/policy", async (c) => {
  if (!auditAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const phone = c.req.query("phone") ?? undefined;
  const since = c.req.query("since") ?? undefined;
  const limit = Number(c.req.query("limit") ?? 100);
  const format = c.req.query("format") ?? "json";
  const rows = await listPolicyAudit({ phone, since, limit });
  if (format === "csv") {
    const header = "id,phone,action,verdict,reason,amount_usdc,payee,created_at";
    const lines = rows.map((r) =>
      [
        r.id,
        r.phone,
        r.action,
        r.verdict,
        JSON.stringify(r.reason ?? ""),
        r.amount_usdc ?? "",
        JSON.stringify(r.payee ?? ""),
        r.created_at,
      ].join(","),
    );
    return c.text([header, ...lines].join("\n"), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="policy-audit.csv"',
    });
  }
  return c.json({ count: rows.length, rows });
});

app.get("/v1/agi/last", (c) => {
  if (!auditAuthorized(c) && hotlineProfile() !== "lab") {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (hotlineProfile() === "lab" && process.env.AUDIT_EXPORT_TOKEN && !auditAuthorized(c)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const phone = c.req.query("phone") ?? "";
  if (!phone) return c.json({ error: "phone query required" }, 400);
  const reply = lastAgiReply.get(phone) ?? lastAgiReply.get(normalizePhone(phone)) ?? null;
  return c.json({ phone: normalizePhone(phone), reply });
});

app.get("/v1/channels", (c) => {
  if (hotlineProfile() !== "lab" && !auditAuthorized(c)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json(channelStatus());
});

app.post("/v1/call/start", async (c) => {
  const denied = requireLabHttp(c);
  if (denied) return denied;
  const body = await c.req.json<{ phone?: string }>();
  if (!body.phone) return c.json({ error: "phone required" }, 400);
  const limited = rateLimited(c, body.phone);
  if (limited) return limited;
  const { handleCallStart } = await import("./lib/pipeline.js");
  const result = await handleCallStart(body.phone);
  return c.json(result);
});

/** Flash / missed call → balance SMS */
app.post("/v1/call/missed", async (c) => {
  const denied = requireLabHttp(c);
  if (denied) return denied;
  const body = await c.req.json<{ phone?: string }>();
  if (!body.phone) return c.json({ error: "phone required" }, 400);
  const limited = rateLimited(c, body.phone);
  if (limited) return limited;
  const { handleMissedCall } = await import("./lib/pipeline.js");
  return c.json(await handleMissedCall(body.phone));
});

/** Dial-a-rate guest path */
app.post("/v1/call/rate", async (c) => {
  const denied = requireLabHttp(c);
  if (denied) return denied;
  const body = await c.req.json<{ phone?: string }>().catch(() => ({} as { phone?: string }));
  const { handleDialRate } = await import("./lib/pipeline.js");
  return c.json(await handleDialRate(body.phone));
});

app.post("/v1/message", async (c) => {
  const denied = requireLabHttp(c);
  if (denied) return denied;
  const body = await c.req.json<{ phone?: string; account?: string; text?: string }>();
  const who = body.account ?? body.phone;
  if (!who || body.text == null) return c.json({ error: "phone/account and text required" }, 400);
  const limited = rateLimited(c, who);
  if (limited) return limited;
  const result = await handleMessage(who, body.text || "hi");
  return c.json(result);
});

/** Agent-to-human + marketplace x402 surface */
app.get("/v1/x402", async (c) => {
  const { X402_RESOURCES, marketplaceAliasesForAgents } = await import("./lib/x402.js");
  return c.json({
    service: "hotline.guru",
    framing:
      "Agent-to-human last mile + Circle marketplace chaining — pay once, reach a phone or buy any allowlisted x402",
    resources: X402_RESOURCES,
    marketplaceAliases: marketplaceAliasesForAgents(),
    catalog: "https://agents.circle.com/services",
    discovery: "https://api.circle.com/v2/x402/discovery/resources",
  });
});

app.post("/v1/x402/:capability", async (c) => {
  const capabilityRaw = c.req.param("capability");
  const { fulfillX402, isX402Capability, paymentRequiredBody, verifyX402Payment } =
    await import("./lib/x402.js");
  if (!isX402Capability(capabilityRaw)) {
    return c.json({ error: "unknown capability", hint: "GET /v1/x402" }, 404);
  }
  const capability = capabilityRaw;
  const body = await c.req.json<{
    to?: string;
    amount?: number;
    question?: string;
    memo?: string;
    symbol?: string;
    query?: string;
    task?: string;
    url?: string;
    method?: "GET" | "POST" | "PUT";
    data?: unknown;
    provider?: "stablephone" | "bland";
    web?: boolean;
    handle?: string;
    qty?: number;
    payment?: { proof?: string };
  }>();

  const paid = verifyX402Payment({
    capability,
    body,
    paymentHeader: c.req.header("x-payment") ?? undefined,
    paymentProof: body.payment?.proof,
  });
  if (!paid.ok) {
    return c.json(paymentRequiredBody(capability), 402);
  }

  const limited = rateLimited(c, body.to ?? body.url ?? body.query ?? capability);
  if (limited) return limited;

  const result = await fulfillX402({
    capability,
    to: body.to,
    amount: body.amount,
    question: body.question,
    memo: body.memo,
    symbol: body.symbol,
    query: body.query,
    task: body.task,
    url: body.url,
    method: body.method,
    data: body.data,
    provider: body.provider,
    web: body.web,
    handle: body.handle,
    qty: body.qty,
  });
  return c.json({ ...result, paymentMode: paid.mode });
});

app.get("/webhooks/whatsapp", (c) => {
  const challenge = whatsappVerifyChallenge({
    "hub.mode": c.req.query("hub.mode") ?? undefined,
    "hub.verify_token": c.req.query("hub.verify_token") ?? undefined,
    "hub.challenge": c.req.query("hub.challenge") ?? undefined,
  });
  if (challenge == null) return c.text("Forbidden", 403);
  return c.text(challenge);
});

app.post("/webhooks/whatsapp", async (c) => {
  const raw = await c.req.text();
  const v = verifyWhatsAppSignature(raw, c.req.header("x-hub-signature-256"));
  if (!v.ok) {
    log.warn("whatsapp webhook rejected", { reason: v.reason });
    return c.json({ error: v.reason }, 401);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: "bad json" }, 400);
  }
  const messages = parseWhatsAppWebhook(payload);
  const replies: string[] = [];
  for (const m of messages) {
    const limited = rateLimited(c, m.account);
    if (limited) return limited;
    try {
      const result = await handleInboundWhatsApp(m.account, m.text, m.fromWaId, whatsapp);
      replies.push(result.reply);
      log.info("whatsapp inbound", { account: m.account, messageId: m.messageId });
    } catch (e) {
      log.warn("whatsapp handle failed", { err: String(e), account: m.account });
    }
  }
  return c.json({ ok: true, handled: messages.length, replies });
});

app.post("/webhooks/telegram", async (c) => {
  const raw = await c.req.text();
  const v = verifyTelegramSecret(c.req.header("x-telegram-bot-api-secret-token"));
  if (!v.ok) {
    log.warn("telegram webhook rejected", { reason: v.reason });
    return c.json({ error: v.reason }, 401);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: "bad json" }, 400);
  }
  const inbound = parseTelegramUpdate(payload);
  if (!inbound) return c.json({ ok: true, handled: 0 });
  const limited = rateLimited(c, inbound.account);
  if (limited) return limited;
  try {
    const result = await handleInboundTelegram(
      inbound.account,
      inbound.text,
      inbound.chatId,
      telegram,
    );
    log.info("telegram inbound", { account: inbound.account, username: inbound.username });
    return c.json({ ok: true, handled: 1, reply: result.reply });
  } catch (e) {
    log.warn("telegram handle failed", { err: String(e), account: inbound.account });
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

app.post("/webhooks/sms/telnyx", async (c) => {
  const raw = await c.req.text();
  const v = verifyTelnyxSignature(raw, {
    signature: c.req.header("telnyx-signature-ed25519") ?? c.req.header("x-telnyx-signature"),
    timestamp: c.req.header("telnyx-timestamp") ?? c.req.header("x-telnyx-timestamp"),
  });
  if (!v.ok) {
    log.warn("telnyx webhook rejected", { reason: v.reason });
    return c.json({ error: v.reason }, 401);
  }
  const payload = JSON.parse(raw) as {
    data?: { payload?: { from?: { phone_number?: string }; text?: string } };
    from?: string;
    text?: string;
  };
  const from = payload?.data?.payload?.from?.phone_number ?? payload?.from ?? "";
  const text = payload?.data?.payload?.text ?? payload?.text ?? "";
  if (!from || !text) return c.json({ error: "bad payload" }, 400);
  const limited = rateLimited(c, from);
  if (limited) return limited;
  const result = await handleInboundSms(from, text, sms);
  return c.json({ ok: true, reply: result.reply });
});

app.post("/webhooks/sms/at", async (c) => {
  const v = verifyAtWebhook({
    headerSecret: c.req.header("x-at-secret") ?? c.req.header("x-hotline-at-secret"),
    // Query secrets only allowed in lab (leak into access logs)
    querySecret: hotlineProfile() === "lab" ? c.req.query("secret") : undefined,
  });
  if (!v.ok) {
    log.warn("at webhook rejected", { reason: v.reason });
    return c.text(v.reason ?? "unauthorized", 401);
  }
  const form = await c.req.parseBody();
  const from = String(form.from ?? form.From ?? "");
  const text = String(form.text ?? form.Body ?? "");
  if (!from || !text) return c.text("Missing", 400);
  const limited = rateLimited(c, from);
  if (limited) return limited;
  await handleInboundSms(from, text, sms);
  return c.text("OK");
});

app.post("/webhooks/sms", async (c) => {
  const raw = await c.req.text();
  const v = verifyGenericHmac(raw, c.req.header("x-hotline-signature"));
  if (!v.ok) {
    log.warn("sms webhook rejected", { reason: v.reason });
    return c.json({ error: v.reason }, 401);
  }
  const params = new URLSearchParams(raw);
  const from = params.get("From") ?? params.get("from") ?? "";
  const text = params.get("Body") ?? params.get("text") ?? params.get("message") ?? "";
  if (!from || !text) return c.json({ error: "From and Body required" }, 400);
  const limited = rateLimited(c, from);
  if (limited) return limited;
  const result = await handleInboundSms(from, text, sms);
  return c.json(result);
});

/**
 * Twilio Programmable Voice. Twilio POSTs here and reads our TwiML aloud, so a
 * real inbound number works over HTTPS (ngrok included) with no public SIP host.
 * Point the number's "A call comes in" webhook at /webhooks/twilio/voice.
 */
async function twilioParams(c: Context): Promise<{ params: Record<string, string>; ok: boolean; reason?: string }> {
  const raw = await c.req.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
  // Twilio signs the exact URL it called, so honour the proxy headers ngrok sets.
  const proto = c.req.header("x-forwarded-proto") ?? "https";
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "";
  const url = `${proto}://${host}${new URL(c.req.url).pathname}`;
  const v = verifyTwilioSignature(url, params, c.req.header("x-twilio-signature"));
  return { params, ok: v.ok, reason: v.reason };
}

function twimlFor(result: HandleResult): string {
  // PIN turns collect keypad digits; the expectation rides in the action URL
  // because the pipeline needs "PIN 1234" / "CONFIRM 1234", not bare digits.
  const expect = result.needsSetPin ? "setpin" : result.needsPin ? "pin" : undefined;
  return twiml({ reply: result.reply, expect });
}

app.post("/webhooks/twilio/voice", async (c) => {
  const { params, ok, reason } = await twilioParams(c);
  if (!ok) {
    log.warn("twilio webhook rejected", { reason });
    return c.text(reason ?? "unauthorized", 401);
  }
  const from = params.From ?? "";
  if (!from) return c.text("From required", 400);
  const limited = rateLimited(c, from);
  if (limited) return limited;
  const result = await handleCallStart(from);
  log.info("twilio call start", { callSid: params.CallSid });
  return c.body(twimlFor(result), 200, { "content-type": "text/xml" });
});

app.post("/webhooks/twilio/gather", async (c) => {
  const { params, ok, reason } = await twilioParams(c);
  if (!ok) {
    log.warn("twilio webhook rejected", { reason });
    return c.text(reason ?? "unauthorized", 401);
  }
  const from = params.From ?? "";
  if (!from) return c.text("From required", 400);
  const limited = rateLimited(c, from);
  if (limited) return limited;

  const text = callerText(params);
  if (!text) {
    // Nothing heard — one nudge, then hang up rather than loop forever on an open line.
    const idle = c.req.query("idle") === "1";
    return c.body(
      twiml({ reply: idle ? "Still there? Call back anytime." : "Sorry, I didn't catch that.", hangup: idle }),
      200,
      { "content-type": "text/xml" },
    );
  }
  const result = await handleMessage(from, textForPipeline(text, c.req.query("expect")));
  return c.body(twimlFor(result), 200, { "content-type": "text/xml" });
});

const port = Number(process.env.PORT ?? 8787);
const agiPort = Number(process.env.AGI_PORT ?? 4573);

assertProfileConfig();
await initDb();
const moneyPath = resolveWalletMode();
log.info("db ready", {
  driver: process.env.DATABASE_URL ? "postgres" : "sqlite",
  profile: hotlineProfile(),
  walletMode: moneyPath,
  circleConfigured: circleConfigured(),
  gasStation: circleGasStationEnabled(),
  channels: channelStatus(),
});

serve({ fetch: app.fetch, port }, () => {
  log.info("http listening", {
    port,
    whatsapp: whatsapp.name,
    telegram: telegram.name,
    walletMode: moneyPath,
  });
});

startAgiServer(agiPort);
log.info("agi listening", { port: agiPort });

startWorkers();
