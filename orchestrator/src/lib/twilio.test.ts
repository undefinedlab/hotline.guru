import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyTwilioSignature, twiml, speakable, callerText, textForPipeline } from "./twilio.js";

const URL_ = "https://demo.example.com/webhooks/twilio/voice";
const PARAMS = { From: "+15551230001", CallSid: "CA123", SpeechResult: "hello" };

function sign(token: string, url: string, params: Record<string, string>): string {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

test("twilio signature verification", () => {
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.WEBHOOK_VERIFY = "1";

  assert.equal(verifyTwilioSignature(URL_, PARAMS, sign("test-token", URL_, PARAMS)).ok, true);

  // Wrong token, tampered param, and missing header must all fail closed.
  assert.equal(verifyTwilioSignature(URL_, PARAMS, sign("other", URL_, PARAMS)).ok, false);
  const tampered = { ...PARAMS, From: "+19999999999" };
  assert.equal(verifyTwilioSignature(URL_, tampered, sign("test-token", URL_, PARAMS)).ok, false);
  assert.equal(verifyTwilioSignature(URL_, PARAMS, undefined).ok, false);

  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.WEBHOOK_VERIFY;
});

test("twiml speaks replies without reading URLs aloud", () => {
  const withLink = "Sent 0.1 USDC. Tx https://testnet.arcscan.app/tx/0xabc123";
  assert.ok(!speakable(withLink).includes("http"), "URL must not be spoken");
  assert.ok(speakable(withLink).includes("Sent 0.1 USDC"));
  assert.equal(speakable("https://only-a-link.example"), "Done.", "never emit an empty Say");

  // PIN turns must collect keypad digits, not speech.
  const pin = twiml({ reply: "Enter your PIN", expect: "pin" });
  assert.ok(pin.includes('input="dtmf"') && pin.includes('numDigits="4"'));
  assert.ok(pin.includes("expect=pin"), "digit meaning must survive the round trip");

  const open = twiml({ reply: "What can I do?" });
  assert.ok(open.includes('input="speech dtmf"'));
  assert.ok(open.includes("<Redirect"), "silence must not leave the call hanging");

  assert.ok(twiml({ reply: "Bye", hangup: true }).includes("<Hangup/>"));
  // XML-escape or Twilio rejects the document.
  assert.ok(twiml({ reply: 'Ben & "Sam" <hi>' }).includes("&amp;"));
});

test("caller text prefers speech then keypad", () => {
  assert.equal(callerText({ SpeechResult: "send five dollars" }), "send five dollars");
  assert.equal(callerText({ Digits: "1234" }), "1234");
  assert.equal(callerText({}), "");
});

test("keypad digits become the command the pipeline parses", () => {
  // The real bug: bare digits set no PIN and confirm nothing, so the call loops.
  assert.equal(textForPipeline("2468", "setpin"), "PIN 2468");
  assert.equal(textForPipeline("2468", "pin"), "CONFIRM 2468");
  assert.equal(textForPipeline("2468", undefined), "2468");
  assert.equal(textForPipeline("send 5 to bob", "pin"), "send 5 to bob", "speech passes through");
});
