/**
 * Airtime top-up — USDC debit → mobile minutes/data.
 *
 * Providers:
 *  - mock: settle on-chain to AIRTIME_SINK, invent voucher id (demo)
 *  - reloadly: debit USDC then call Reloadly sandbox/live; refund USDC if API fails
 *
 * Shared by voice + SMS + Telegram/WhatsApp through the same pipeline/PIN path.
 */
import { type Address } from "viem";
import { getUser, normalizePhone } from "./db.js";
import { ensureWallet, transferUsdc } from "./wallets.js";
import { log } from "./log.js";
import { reloadlyEnv, sendReloadlyTopup } from "./reloadly.js";

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

async function refundAirtimeUsdc(opts: {
  toPhone: string;
  amountUsdc: number;
}): Promise<{ txHash?: string; explorer?: string } | null> {
  try {
    const user = await getUser(opts.toPhone);
    if (!user) {
      log.error("airtime refund skipped, user missing", { phone: opts.toPhone });
      return null;
    }
    const out = await transferUsdc({
      fromPhone: airtimeSinkPhone(),
      toAddress: user.wallet_address as Address,
      amountUsdc: opts.amountUsdc,
    });
    log.warn("airtime USDC refunded after provider failure", {
      to: opts.toPhone,
      amountUsdc: opts.amountUsdc,
      txHash: out.txHash,
    });
    return out;
  } catch (e) {
    log.error("airtime refund FAILED, manual ops needed", {
      to: opts.toPhone,
      amountUsdc: opts.amountUsdc,
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

function mockVoucherId(): string {
  return `AT-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1e4)
    .toString()
    .padStart(4, "0")}`;
}

/**
 * Fulfill airtime: charge payer USDC to sink, then call provider.
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
    const customIdentifier = `hl-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)
      .toString(36)}`;
    try {
      const topup = await sendReloadlyTopup({
        msisdn: opts.quote.msisdn,
        senderMsisdn: opts.fromPhone,
        amount: opts.quote.faceAmount,
        // EUR → local currency face; USD → international (USD) amount
        useLocalAmount: opts.quote.faceCurrency === "EUR",
        customIdentifier,
      });
      const voucherId = `RL-${topup.transactionId}`;
      log.info("airtime fulfilled via Reloadly", {
        from: opts.fromPhone,
        msisdn: opts.quote.msisdn,
        face: `${opts.quote.faceAmount} ${opts.quote.faceCurrency}`,
        chargeUsdc: opts.quote.chargeUsdc,
        voucherId,
        txHash,
        env: reloadlyEnv(),
        operator: topup.operatorName,
        status: topup.status,
      });
      return {
        ok: true,
        voucherId,
        txHash,
        explorer,
        summary: `${opts.quote.productLabel} for ${opts.quote.msisdn}`,
        raw: { provider: "reloadly", env: reloadlyEnv(), topup: topup.raw },
      };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log.error("reloadly topup failed, refunding USDC", { err, msisdn: opts.quote.msisdn });
      await refundAirtimeUsdc({
        toPhone: opts.fromPhone,
        amountUsdc: opts.quote.chargeUsdc,
      });
      throw new Error(`Airtime provider failed (USDC refunded if possible): ${err}`);
    }
  }

  const voucherId = mockVoucherId();
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
    raw: { provider, mock: true },
  };
}
