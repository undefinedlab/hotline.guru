/**
 * Reloadly Airtime API — sandbox or live.
 *
 * Auth: OAuth client_credentials → Bearer token (cached).
 * Flow: auto-detect operator → POST /topups
 *
 * Docs: https://developers.reloadly.com/ · sandbox: topups-sandbox.reloadly.com
 */
import { log } from "./log.js";

export type ReloadlyEnv = "sandbox" | "live";

type TokenCache = { token: string; expiresAt: number; audience: string };

let tokenCache: TokenCache | null = null;

export function reloadlyEnv(): ReloadlyEnv {
  const v = (process.env.RELOADLY_ENV ?? process.env.AIRTIME_RELOADLY_ENV ?? "sandbox")
    .toLowerCase()
    .trim();
  return v === "live" || v === "production" || v === "prod" ? "live" : "sandbox";
}

export function reloadlyAudience(env: ReloadlyEnv = reloadlyEnv()): string {
  return env === "live"
    ? "https://topups.reloadly.com"
    : "https://topups-sandbox.reloadly.com";
}

export function reloadlyCredentials(): { clientId: string; clientSecret: string } {
  const clientId = (
    process.env.RELOADLY_CLIENT_ID ??
    process.env.AIRTIME_RELOADLY_CLIENT_ID ??
    ""
  ).trim();
  const clientSecret = (
    process.env.RELOADLY_CLIENT_SECRET ??
    process.env.AIRTIME_RELOADLY_CLIENT_SECRET ??
    ""
  ).trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Reloadly credentials missing — set RELOADLY_CLIENT_ID and RELOADLY_CLIENT_SECRET (sandbox keys from portal Sandbox toggle)",
    );
  }
  return { clientId, clientSecret };
}

/**
 * Map E.164 (+digits) → ISO 3166-1 alpha-2 for Reloadly auto-detect.
 * Longest-prefix match; covers demo / high-traffic corridors.
 */
const CC_PREFIXES: Array<{ prefix: string; iso: string }> = [
  { prefix: "353", iso: "IE" },
  { prefix: "44", iso: "GB" },
  { prefix: "33", iso: "FR" },
  { prefix: "49", iso: "DE" },
  { prefix: "34", iso: "ES" },
  { prefix: "39", iso: "IT" },
  { prefix: "31", iso: "NL" },
  { prefix: "32", iso: "BE" },
  { prefix: "351", iso: "PT" },
  { prefix: "48", iso: "PL" },
  { prefix: "380", iso: "UA" },
  { prefix: "234", iso: "NG" },
  { prefix: "233", iso: "GH" },
  { prefix: "254", iso: "KE" },
  { prefix: "255", iso: "TZ" },
  { prefix: "256", iso: "UG" },
  { prefix: "27", iso: "ZA" },
  { prefix: "212", iso: "MA" },
  { prefix: "221", iso: "SN" },
  { prefix: "225", iso: "CI" },
  { prefix: "237", iso: "CM" },
  { prefix: "91", iso: "IN" },
  { prefix: "62", iso: "ID" },
  { prefix: "63", iso: "PH" },
  { prefix: "66", iso: "TH" },
  { prefix: "84", iso: "VN" },
  { prefix: "55", iso: "BR" },
  { prefix: "52", iso: "MX" },
  { prefix: "57", iso: "CO" },
  { prefix: "51", iso: "PE" },
  { prefix: "54", iso: "AR" },
  { prefix: "61", iso: "AU" },
  { prefix: "64", iso: "NZ" },
  { prefix: "81", iso: "JP" },
  { prefix: "82", iso: "KR" },
  { prefix: "86", iso: "CN" },
  { prefix: "971", iso: "AE" },
  { prefix: "966", iso: "SA" },
  { prefix: "1", iso: "US" }, // NANP — US default; CA shares +1
].sort((a, b) => b.prefix.length - a.prefix.length);

export function countryIsoFromE164(msisdn: string): string {
  const override = (process.env.RELOADLY_DEFAULT_COUNTRY ?? "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(override)) return override;
  const digits = msisdn.replace(/\D/g, "");
  for (const { prefix, iso } of CC_PREFIXES) {
    if (digits.startsWith(prefix)) return iso;
  }
  throw new Error(`Cannot map ${msisdn} to a country ISO — set RELOADLY_DEFAULT_COUNTRY=IE`);
}

export function e164Digits(msisdn: string): string {
  return msisdn.replace(/\D/g, "");
}

async function getAccessToken(): Promise<{ token: string; baseUrl: string }> {
  const audience = reloadlyAudience();
  const now = Date.now();
  if (tokenCache && tokenCache.audience === audience && tokenCache.expiresAt > now + 60_000) {
    return { token: tokenCache.token, baseUrl: audience };
  }

  const { clientId, clientSecret } = reloadlyCredentials();
  const res = await fetch("https://auth.reloadly.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      audience,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    message?: string;
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Reloadly auth failed (${res.status}): ${body.message ?? body.error ?? res.statusText}`,
    );
  }
  const ttlSec = Number(body.expires_in ?? 86_400);
  tokenCache = {
    token: body.access_token,
    audience,
    expiresAt: now + Math.max(60, ttlSec - 120) * 1000,
  };
  log.info("reloadly token acquired", { env: reloadlyEnv(), ttlSec });
  return { token: body.access_token, baseUrl: audience };
}

async function reloadlyFetch<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { token, baseUrl } = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/com.reloadly.topups-v1+json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  let body: string | undefined;
  if (init?.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: body ?? init?.body,
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { message: text };
  }
  if (!res.ok) {
    const err = parsed as { message?: string; errorCode?: string };
    throw new Error(
      `Reloadly ${path} failed (${res.status}): ${err.message ?? err.errorCode ?? text.slice(0, 200)}`,
    );
  }
  return parsed as T;
}

export type ReloadlyOperator = {
  operatorId?: number;
  id?: number;
  name?: string;
  denominationType?: string;
  supportsLocalAmounts?: boolean;
  destinationCurrencyCode?: string;
  localMinAmount?: number;
  localMaxAmount?: number;
  minAmount?: number;
  maxAmount?: number;
  fixedAmounts?: number[];
  localFixedAmounts?: number[];
};

export async function autoDetectOperator(
  msisdn: string,
  countryIso?: string,
): Promise<ReloadlyOperator> {
  const iso = (countryIso ?? countryIsoFromE164(msisdn)).toUpperCase();
  const phone = e164Digits(msisdn);
  const op = await reloadlyFetch<ReloadlyOperator>(
    `/operators/auto-detect/phone/${encodeURIComponent(phone)}/countries/${iso}`,
  );
  const operatorId = Number(op.operatorId ?? op.id);
  if (!Number.isFinite(operatorId) || operatorId <= 0) {
    throw new Error(`Reloadly could not detect operator for ${msisdn} (${iso})`);
  }
  return { ...op, operatorId };
}

export type ReloadlyTopupResult = {
  transactionId: number | string;
  status?: string;
  operatorTransactionId?: string | null;
  operatorName?: string;
  deliveredAmount?: number;
  deliveredAmountCurrencyCode?: string;
  customIdentifier?: string;
  raw: unknown;
};

export async function sendReloadlyTopup(opts: {
  msisdn: string;
  senderMsisdn: string;
  amount: number;
  /** Local operator currency (EUR for IE) vs USD international amount. */
  useLocalAmount: boolean;
  customIdentifier: string;
  operatorId?: number;
  countryIso?: string;
}): Promise<ReloadlyTopupResult> {
  const overrideId = Number(
    opts.operatorId ?? process.env.RELOADLY_OPERATOR_ID ?? process.env.AIRTIME_RELOADLY_OPERATOR_ID ?? "",
  );
  let operatorId = Number.isFinite(overrideId) && overrideId > 0 ? overrideId : 0;
  let operator: ReloadlyOperator | null = null;

  if (!operatorId) {
    operator = await autoDetectOperator(opts.msisdn, opts.countryIso);
    operatorId = Number(operator.operatorId);
  }

  const recipientIso = (opts.countryIso ?? countryIsoFromE164(opts.msisdn)).toUpperCase();
  const senderIso = countryIsoFromE164(opts.senderMsisdn);
  let amount = opts.amount;

  // FIXED denominations: snap to nearest allowed amount when close.
  if (operator?.denominationType === "FIXED") {
    const list = opts.useLocalAmount
      ? operator.localFixedAmounts ?? []
      : operator.fixedAmounts ?? [];
    if (list.length && !list.some((a) => Math.abs(a - amount) < 1e-6)) {
      const nearest = list.reduce((best, a) =>
        Math.abs(a - amount) < Math.abs(best - amount) ? a : best,
      );
      if (Math.abs(nearest - amount) / amount > 0.15) {
        throw new Error(
          `Operator only allows fixed amounts [${list.join(", ")}] — asked ${amount}`,
        );
      }
      log.warn("reloadly snapping to fixed denomination", {
        asked: amount,
        nearest,
        operatorId,
      });
      amount = nearest;
    }
  }

  const payload = {
    operatorId,
    amount,
    useLocalAmount: opts.useLocalAmount,
    customIdentifier: opts.customIdentifier,
    recipientPhone: {
      countryCode: recipientIso,
      number: e164Digits(opts.msisdn),
    },
    senderPhone: {
      countryCode: senderIso,
      number: e164Digits(opts.senderMsisdn),
    },
  };

  log.info("reloadly topup request", {
    env: reloadlyEnv(),
    operatorId,
    amount,
    useLocalAmount: opts.useLocalAmount,
    msisdn: opts.msisdn,
    customIdentifier: opts.customIdentifier,
  });

  const raw = await reloadlyFetch<Record<string, unknown>>("/topups", {
    method: "POST",
    json: payload,
  });

  const status = String(raw.status ?? "SUCCESSFUL").toUpperCase();
  if (status === "FAILED" || status === "REFUNDED") {
    throw new Error(`Reloadly top-up ${status}: ${JSON.stringify(raw).slice(0, 240)}`);
  }

  const transactionId = raw.transactionId ?? raw.operatorTransactionId;
  if (transactionId == null) {
    throw new Error(`Reloadly top-up missing transactionId: ${JSON.stringify(raw).slice(0, 240)}`);
  }

  return {
    transactionId: transactionId as number | string,
    status,
    operatorTransactionId: (raw.operatorTransactionId as string | null) ?? null,
    operatorName: raw.operatorName as string | undefined,
    deliveredAmount: raw.deliveredAmount as number | undefined,
    deliveredAmountCurrencyCode: raw.deliveredAmountCurrencyCode as string | undefined,
    customIdentifier: raw.customIdentifier as string | undefined,
    raw,
  };
}

/** Test helper — clear cached OAuth token. */
export function clearReloadlyTokenCache(): void {
  tokenCache = null;
}
