import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  accountFromTelegram,
  accountFromWhatsApp,
  canReceiveSms,
  isTelegramAccount,
  linkTelegramToPhone,
  resolveCanonicalAccount,
} from "./channel.js";
import { parseWhatsAppWebhook, whatsappVerifyChallenge } from "./whatsapp.js";
import { MockTelegramProvider, parseTelegramUpdate } from "./telegram.js";
import { MockWhatsAppProvider } from "./whatsapp.js";
import { handleInboundTelegram, handleInboundWhatsApp } from "./ingress.js";
import fs from "node:fs";

process.env.DATABASE_PATH = "./data/ingress-test.db";
process.env.WALLET_MODE = "local";
process.env.DEMO_SIMPLE = "1";
process.env.WHATSAPP_PROVIDER = "mock";
process.env.TELEGRAM_PROVIDER = "mock";
delete process.env.DATABASE_URL;
try {
  fs.unlinkSync("./data/ingress-test.db");
} catch {
  /* ok */
}

const { initDb, normalizePhone, getUser, resolveLinkedPhone } = await import("./db.js");
await initDb();

describe("channel identity", () => {
  it("maps WhatsApp id to E.164 (same account as SMS)", () => {
    assert.equal(accountFromWhatsApp("15551234567"), "+15551234567");
    assert.equal(canReceiveSms("+15551234567"), true);
  });

  it("maps Telegram chat to tg: account", () => {
    assert.equal(accountFromTelegram(424242), "tg:424242");
    assert.equal(normalizePhone("tg:424242"), "tg:424242");
    assert.equal(isTelegramAccount("tg:424242"), true);
    assert.equal(canReceiveSms("tg:424242"), false);
  });
});

describe("webhook parsers", () => {
  it("parses Meta WhatsApp text messages", () => {
    const msgs = parseWhatsAppWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "15559876543",
                    id: "wamid.1",
                    type: "text",
                    text: { body: "balance" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.account, "+15559876543");
    assert.equal(msgs[0]!.text, "balance");
  });

  it("parses Telegram message updates", () => {
    const inbound = parseTelegramUpdate({
      message: {
        message_id: 9,
        text: "hello",
        chat: { id: 777 },
        from: { id: 777, username: "bob" },
      },
    });
    assert.equal(inbound?.account, "tg:777");
    assert.equal(inbound?.text, "hello");
  });

  it("parses own Telegram contact share", () => {
    const inbound = parseTelegramUpdate({
      message: {
        message_id: 10,
        chat: { id: 888 },
        from: { id: 888, username: "alice" },
        contact: { phone_number: "353899494966", user_id: 888 },
      },
    });
    assert.equal(inbound?.account, "tg:888");
    assert.equal(inbound?.contactPhone, "+353899494966");
    assert.equal(inbound?.text, "hi");
  });

  it("rejects third-party Telegram contact cards", () => {
    const inbound = parseTelegramUpdate({
      message: {
        message_id: 11,
        chat: { id: 888 },
        from: { id: 888 },
        contact: { phone_number: "+15551230099", user_id: 999 },
      },
    });
    assert.equal(inbound, null);
  });

  it("answers WhatsApp verify challenge", () => {
    process.env.WHATSAPP_VERIFY_TOKEN = "secret-token";
    const c = whatsappVerifyChallenge({
      "hub.mode": "subscribe",
      "hub.verify_token": "secret-token",
      "hub.challenge": "12345",
    });
    assert.equal(c, "12345");
  });
});

describe("ingress replies on channel", () => {
  it("WhatsApp mock send after pipeline", async () => {
    const wa = new MockWhatsAppProvider();
    const r = await handleInboundWhatsApp("+15557770001", "hi", "15557770001", wa);
    assert.match(r.reply, /Welcome|name/i);
    assert.equal(wa.sent.length, 1);
    assert.equal(wa.sent[0]!.to, "15557770001");
  });

  it("Telegram unlinked asks for Share contact and does not mint tg wallet", async () => {
    const tg = new MockTelegramProvider();
    const r = await handleInboundTelegram("tg:888001", "hi", "888001", tg);
    assert.match(r.reply, /Share your phone/i);
    assert.equal(r.data?.needsPhoneLink, true);
    assert.equal(tg.sent.length, 1);
    assert.equal(tg.sent[0]!.opts?.requestContact, true);
    assert.equal(await getUser("tg:888001"), undefined);
  });

  it("Telegram contact link uses E.164 wallet shared with phone", async () => {
    const phone = "+15557770111";
    // Pre-create phone account (as if they already called/SMS).
    const { ensureWallet } = await import("./wallets.js");
    const prior = await ensureWallet(phone);
    const tg = new MockTelegramProvider();
    const r = await handleInboundTelegram("tg:999002", "hi", "999002", tg, {
      contactPhone: phone,
    });
    assert.match(r.reply, /Linked/i);
    assert.equal(await resolveLinkedPhone("telegram", "999002"), phone);
    assert.equal(await resolveCanonicalAccount("tg:999002"), phone);
    const user = await getUser(phone);
    assert.equal(user?.wallet_address, prior.wallet_address);
    assert.equal(await getUser("tg:999002"), undefined);

    // Second message routes as phone account.
    const tg2 = new MockTelegramProvider();
    const r2 = await handleInboundTelegram("tg:999002", "hi", "999002", tg2);
    assert.equal(r2.data?.needsPhoneLink, undefined);
    assert.match(r2.reply, /Welcome|name|Hey|what can I do/i);
  });

  it("linkTelegramToPhone creates phone wallet when new", async () => {
    const linked = await linkTelegramToPhone("424201", "+15557770222");
    assert.equal(linked.ok, true);
    if (linked.ok) {
      assert.equal(linked.phone, "+15557770222");
      assert.ok(await getUser("+15557770222"));
    }
  });
});
