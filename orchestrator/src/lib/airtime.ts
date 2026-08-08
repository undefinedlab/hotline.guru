/**
 * Airtime top-up — USDC debit → mobile minutes/data.
 *
 * Mock provider settles on-chain to AIRTIME_SINK and records a voucher id (demo).
 * Swap AIRTIME_PROVIDER=reloadly later without changing the voice/PIN path.
 */
import { type Address } from "viem";
import { normalizePhone } from "./db.js";
import { ensureWallet, transferUsdc } from "./wallets.js";
import { log } from "./log.js";

export type AirtimeCurrency = "EUR" | "USD";

export type AirtimeQuote = {
  faceAmount: number;
  faceCurrency: AirtimeCurrency;
  chargeUsdc: number;
  msisdn: string;
  provider: string;
  productLabel: string;
};

export type AirtimeResult = {
  ok: boolean;
  voucherId: string;
  txHash?: string;
  explorer?: string;
  summary: string;
  raw?: unknown;
};

export function airtimeSinkPhone(): string {
  return normalizePhone(
    process.env.AIRTIME_SINK_ACCOUNT ??
      process.env.X402_OPS_ACCOUNT ??
      process.env.ESCROW_ACCOUNT ??
      "+10000000001",
  );
}

/** Mock FX: 1 EUR ≈ 1.08 USDC (hackathon-stable). USD face = 1:1 USDC. */
export function quoteAirtimeCharge(
  faceAmount: number,
  faceCurrency: AirtimeCurrency,
): number {
  const feeBps = Number(process.env.AIRTIME_FEE_BPS ?? 50); // 0.5%
  const fx = faceCurrency === "EUR" ? Number(process.env.AIRTIME_EUR_USD ?? 1.08) : 1;
  const gross = faceAmount * fx;
  const fee = gross * (Math.max(0, feeBps) / 10_000);
  return Math.round((gross + fee) * 1e6) / 1e6;
}

export function buildAirtimeQuote(opts: {
  faceAmount: number;
  faceCurrency: AirtimeCurrency;
  msisdn: string;
}): AirtimeQuote {
  const chargeUsdc = quoteAirtimeCharge(opts.faceAmount, opts.faceCurrency);
  const unit = opts.faceCurrency === "EUR" ? "euro" : "dollar";
  return {
    faceAmount: opts.faceAmount,
    faceCurrency: opts.faceCurrency,
    chargeUsdc,
    msisdn: normalizePhone(opts.msisdn),
    provider: (process.env.AIRTIME_PROVIDER ?? "mock").toLowerCase(),
    productLabel: `${opts.faceAmount} ${unit} airtime`,
  };
}

/**
 * Fulfill airtime: charge payer USDC to sink, then call provider (mock = instant voucher).
 */
export async function fulfillAirtime(opts: {
  fromPhone: string;
  quote: AirtimeQuote;
}): Promise<AirtimeResult> {
  const sink = await ensureWallet(airtimeSinkPhone(), "Airtime");
  const { txHash, explorer } = await transferUsdc({
    fromPhone: opts.fromPhone,
    toAddress: sink.wallet_address as Address,
    amountUsdc: opts.quote.chargeUsdc,
  });

  const provider = opts.quote.provider;
  if (provider === "reloadly") {
    // Hook for live Reloadly — needs AIRTIME_RELOADLY_CLIENT_ID/SECRET + operator mapping.
    log.warn("AIRTIME_PROVIDER=reloadly not fully wired, falling back to mock voucher", {
      msisdn: opts.quote.msisdn,
    });
  }

  const voucherId = `AT-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1e4)
    .toString()
    .padStart(4, "0")}`;

  log.info("airtime fulfilled", {
    from: opts.fromPhone,
    msisdn: opts.quote.msisdn,
    face: `${opts.quote.faceAmount} ${opts.quote.faceCurrency}`,
    chargeUsdc: opts.quote.chargeUsdc,
    voucherId,
    txHash,
    provider,
  });

  return {
    ok: true,
    voucherId,
    txHash,
    explorer,
    summary: `${opts.quote.productLabel} for ${opts.quote.msisdn}`,
    raw: { provider, mock: provider !== "reloadly" },
  };
}
