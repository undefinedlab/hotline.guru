import { loadEnv } from "./lib/env.js";
loadEnv();

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { handleMessage } from "./lib/pipeline.js";
import { createSmsProvider, handleInboundSms } from "./lib/sms.js";
import { lastAgiReply, startAgiServer } from "./agi/server.js";
import { checkDb, initDb, listPolicyAudit, normalizePhone } from "./lib/db.js";
import { checkArcRpc } from "./lib/wallets.js";
import { circleConfigured, circleGasStationEnabled, circleHealth } from "./lib/circle.js";
import { sttHealthy } from "./lib/stt.js";
import { log } from "./lib/log.js";
import { verifyGenericHmac, verifyTelnyxSignature } from "./lib/webhooks.js";

const app = new Hono();
const sms = createSmsProvider();

function auditAuthorized(c: { req: { header: (n: string) => string | undefined } }): boolean {
  const expected = process.env.AUDIT_EXPORT_TOKEN;
  if (!expected) {
    // Lab: open export. Staging/prod: require bearer token.
    return (process.env.HOTLINE_PROFILE ?? "lab") !== "staging" && process.env.WEBHOOK_VERIFY !== "1";
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
    walletMode: process.env.WALLET_MODE ?? "local",
    sms: sms.name,
    circleConfigured: circleConfigured(),
    gasStation: circleGasStationEnabled(),
  };
  if (!deep) return c.json(base);

  const [db, arc, stt, circle] = await Promise.all([
    checkDb(),
    checkArcRpc(),
    sttHealthy(),
    process.env.WALLET_MODE === "circle" ? circleHealth() : Promise.resolve({ ok: true as const }),
  ]);
  const ok = db.ok && arc.ok && (process.env.WALLET_MODE !== "circle" || circle.ok);
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

/** Compliance export — policy gate decisions (ALLOW/REFUSE/confirm). */
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

app.post("/v1/call/start", async (c) => {
  const body = await c.req.json<{ phone?: string }>();
  if (!body.phone) return c.json({ error: "phone required" }, 400);
  const { handleCallStart } = await import("./lib/pipeline.js");
  const result = await handleCallStart(body.phone);
  return c.json(result);
});

app.post("/v1/message", async (c) => {
  const body = await c.req.json<{ phone?: string; text?: string }>();
  if (!body.phone || body.text == null) return c.json({ error: "phone and text required" }, 400);
  const result = await handleMessage(body.phone, body.text || "hi");
  return c.json(result);
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
  const payload = JSON.parse(raw) as any;
  const from =
    payload?.data?.payload?.from?.phone_number ?? payload?.from ?? "";
  const text = payload?.data?.payload?.text ?? payload?.text ?? "";
  if (!from || !text) return c.json({ error: "bad payload" }, 400);
  const result = await handleInboundSms(from, text, sms);
  return c.json({ ok: true, reply: result.reply });
});

app.post("/webhooks/sms/at", async (c) => {
  const form = await c.req.parseBody();
  const from = String(form.from ?? form.From ?? "");
  const text = String(form.text ?? form.Body ?? "");
  if (!from || !text) return c.text("Missing", 400);
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
  const result = await handleInboundSms(from, text, sms);
  return c.json(result);
});

const port = Number(process.env.PORT ?? 8787);
const agiPort = Number(process.env.AGI_PORT ?? 4573);

await initDb();
log.info("db ready", {
  driver: process.env.DATABASE_URL ? "postgres" : "sqlite",
  profile: process.env.HOTLINE_PROFILE ?? "lab",
});

serve({ fetch: app.fetch, port }, () => {
  log.info("http listening", { port });
});

startAgiServer(agiPort);
log.info("agi listening", { port: agiPort });
