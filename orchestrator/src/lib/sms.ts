import { handleMessage } from "../lib/pipeline.js";

export interface SmsProvider {
  name: string;
  /** Send an outbound SMS (receipts). */
  send(to: string, body: string): Promise<void>;
}

export class MockSmsProvider implements SmsProvider {
  name = "mock";
  sent: { to: string; body: string }[] = [];
  async send(to: string, body: string) {
    this.sent.push({ to, body });
    console.log(`[sms:mock] → ${to}: ${body.replace(/\b\d{4,6}\b/g, "****").slice(0, 120)}`);
  }
}

export class TelnyxSmsProvider implements SmsProvider {
  name = "telnyx";
  constructor(
    private apiKey: string,
    private from: string,
  ) {}
  async send(to: string, body: string) {
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to,
        text: body,
      }),
    });
    if (!res.ok) throw new Error(`Telnyx SMS failed: ${res.status} ${await res.text()}`);
  }
}

export class AfricasTalkingSmsProvider implements SmsProvider {
  name = "africas_talking";
  constructor(
    private username: string,
    private apiKey: string,
    private from: string,
  ) {}
  async send(to: string, body: string) {
    const params = new URLSearchParams({
      username: this.username,
      to,
      message: body,
      from: this.from,
    });
    const res = await fetch("https://api.africastalking.com/version1/messaging", {
      method: "POST",
      headers: {
        apiKey: this.apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params,
    });
    if (!res.ok) throw new Error(`AT SMS failed: ${res.status} ${await res.text()}`);
  }
}

export function createSmsProvider(): SmsProvider {
  const kind = process.env.SMS_PROVIDER ?? "mock";
  if (kind === "telnyx") {
    const key = process.env.TELNYX_API_KEY;
    const from = process.env.TELNYX_FROM;
    if (!key || !from) {
      console.warn("[sms] TELNYX_API_KEY/FROM missing, using mock");
      return new MockSmsProvider();
    }
    return new TelnyxSmsProvider(key, from);
  }
  if (kind === "africas_talking") {
    const username = process.env.AT_USERNAME;
    const apiKey = process.env.AT_API_KEY;
    const from = process.env.AT_FROM;
    if (!username || !apiKey || !from) {
      console.warn("[sms] AT credentials missing, using mock");
      return new MockSmsProvider();
    }
    return new AfricasTalkingSmsProvider(username, apiKey, from);
  }
  return new MockSmsProvider();
}

export async function handleInboundSms(from: string, body: string, sms = createSmsProvider()) {
  const result = await handleMessage(from, body);
  await sms.send(from, result.reply);
  return result;
}
