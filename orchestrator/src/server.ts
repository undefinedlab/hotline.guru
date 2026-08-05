import { loadEnv } from "./lib/env.js";
loadEnv();

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { handleMessage } from "./lib/pipeline.js";
import { createSmsProvider, handleInboundSms } from "./lib/sms.js";
import { lastAgiReply, startAgiServer } from "./agi/server.js";
import { checkDb, initDb, listPolicyAudit, normalizePhone } from "./lib/db.js";
import { checkArcRpc, resolveWalletMode } from "./lib/wallets.js";
import { circleConfigured, circleGasStationEnabled, circleHealth } from "./lib/circle.js";
import { sttHealthy } from "./lib/stt.js";
import { log } from "./lib/log.js";
import { verifyAtWebhook, verifyGenericHmac, verifyTelnyxSignature } from "./lib/webhooks.js";
import { assertProfileConfig, channelStatus, hotlineProfile } from "./lib/profile.js";
import { ingressRateLimit } from "./lib/rateLimit.js";
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
  return auth === `Bearer ${expected}` || c.req.header("x-audit-token") === expected;
}

app.get("/health", async (c) => {
  const deep = c.req.query("deep") === "1" || c.req.query("deep") === "true";
  const base = {
    ok: true,
    service: "hotline.guru",
    profile: process.env.HOTLINE_PROFILE ?? "lab",
    walletMode: resolveWalletMode(),
    walletModeConfigured: process.env.WALLET_MODE ?? "circle",
    sms: sms.name,
    whatsapp: whatsapp.name,
    telegram: telegram.name,
    circleConfigured: circleConfigured(),
    gasStation: circleGasStationEnabled(),
    channels: channelStatus(),
  };
  if (!deep) return c.json(base);

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
  const phone = c.req.query("phone") ?? "";
  if (!phone) return c.json({ error: "phone query required" }, 400);
  const reply = lastAgiReply.get(phone) ?? lastAgiReply.get(normalizePhone(phone)) ?? null;
  return c.json({ phone, reply });
});

app.get("/v1/channels", (c) => c.json(channelStatus()));

app.post("/v1/call/start", async (c) => {
  const body = await c.req.json<{ phone?: string }>();
  if (!body.phone) return c.json({ error: "phone required" }, 400);
  const limited = rateLimited(c, body.phone);
  if (limited) return limited;
  const { handleCallStart } = await import("./lib/pipeline.js");
  const result = await handleCallStart(body.phone);
  return c.json(result);
});

app.post("/v1/message", async (c) => {
  const body = await c.req.json<{ phone?: string; account?: string; text?: string }>();
  const who = body.account ?? body.phone;
  if (!who || body.text == null) return c.json({ error: "phone/account and text required" }, 400);
  const limited = rateLimited(c, who);
  if (limited) return limited;
  const result = await handleMessage(who, body.text || "hi");
  return c.json(result);
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
    querySecret: c.req.query("secret"),
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
