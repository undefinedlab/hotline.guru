import { loadEnv } from "./lib/env.js";
loadEnv();

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { handleMessage } from "./lib/pipeline.js";
import { createSmsProvider, handleInboundSms } from "./lib/sms.js";
import { lastAgiReply, startAgiServer } from "./agi/server.js";
import { normalizePhone } from "./lib/db.js";

const app = new Hono();
const sms = createSmsProvider();

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "hotline.guru",
    walletMode: process.env.WALLET_MODE ?? "local",
    sms: sms.name,
  }),
);

/** Softphone / judge: last FastAGI spoken reply for a caller id */
app.get("/v1/agi/last", (c) => {
  const phone = c.req.query("phone") ?? "";
  if (!phone) return c.json({ error: "phone query required" }, 400);
  const reply = lastAgiReply.get(phone) ?? lastAgiReply.get(normalizePhone(phone)) ?? null;
  return c.json({ phone, reply });
});

/** Pickup: greet returning caller or start name onboarding */
app.post("/v1/call/start", async (c) => {
  const body = await c.req.json<{ phone?: string }>();
  if (!body.phone) return c.json({ error: "phone required" }, 400);
  const { handleCallStart } = await import("./lib/pipeline.js");
  const result = await handleCallStart(body.phone);
  return c.json(result);
});

/** Generic chat/SMS-style endpoint for lab & softphone HTTP bridge */
app.post("/v1/message", async (c) => {
  const body = await c.req.json<{ phone?: string; text?: string }>();
  if (!body.phone || body.text == null) return c.json({ error: "phone and text required" }, 400);
  const result = await handleMessage(body.phone, body.text || "hi");
  return c.json(result);
});

/** Telnyx-compatible inbound SMS webhook */
app.post("/webhooks/sms/telnyx", async (c) => {
  const payload = await c.req.json<any>();
  const from =
    payload?.data?.payload?.from?.phone_number ??
    payload?.from ??
    "";
  const text = payload?.data?.payload?.text ?? payload?.text ?? "";
  if (!from || !text) return c.json({ error: "bad payload" }, 400);
  const result = await handleInboundSms(from, text, sms);
  return c.json({ ok: true, reply: result.reply });
});

/** Africa's Talking inbound SMS */
app.post("/webhooks/sms/at", async (c) => {
  const form = await c.req.parseBody();
  const from = String(form.from ?? form.From ?? "");
  const text = String(form.text ?? form.Body ?? "");
  if (!from || !text) return c.text("Missing", 400);
  await handleInboundSms(from, text, sms);
  return c.text("OK");
});

/** Generic form webhook (POST From=&Body=) */
app.post("/webhooks/sms", async (c) => {
  const form = await c.req.parseBody();
  const from = String(form.From ?? form.from ?? "");
  const text = String(form.Body ?? form.text ?? form.message ?? "");
  if (!from || !text) return c.json({ error: "From and Body required" }, 400);
  const result = await handleInboundSms(from, text, sms);
  return c.json(result);
});

const port = Number(process.env.PORT ?? 8787);
const agiPort = Number(process.env.AGI_PORT ?? 4573);

serve({ fetch: app.fetch, port }, () => {
  console.log(`hotline.guru HTTP on :${port}`);
});

startAgiServer(agiPort);
