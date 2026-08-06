/**
 * Pending claims — hold for unknown MSISDNs instead of minting unconsented wallets.
 * Funds move to system escrow; recipient gets them on first successful onboard;
 * unclaimed rows expire back to sender after PENDING_CLAIM_DAYS (default 7).
 */
import { isAddress, type Address } from "viem";
import {
  addLedger,
  createPendingClaim,
  getUser,
  listHeldClaimsForPayee,
  markPendingClaim,
  normalizePhone,
  sumPendingClaimsToday,
  type PendingClaim,
} from "./db.js";
import { ensureWallet, transferUsdc } from "./wallets.js";
import { log, shortHash } from "./log.js";

export const ESCROW_ACCOUNT = () =>
  normalizePhone(process.env.ESCROW_ACCOUNT ?? "+10000000000");

export function pendingClaimDays(): number {
  const n = Number(process.env.PENDING_CLAIM_DAYS ?? 7);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

export function pendingClaimDailyCap(): number {
  const n = Number(process.env.PENDING_CLAIM_DAILY_CAP ?? 20);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

/** Escrow wallet — dedicated account, never a random payee. */
export async function ensureEscrowWallet() {
  return ensureWallet(ESCROW_ACCOUNT(), "Escrow");
}

export async function escrowAddress(): Promise<Address> {
  const configured = process.env.ESCROW_WALLET_ADDRESS;
  if (configured && isAddress(configured)) return configured as Address;
  const u = await ensureEscrowWallet();
  return u.wallet_address as Address;
}

export async function assertCanOpenPendingClaim(fromPhone: string): Promise<void> {
  const today = await sumPendingClaimsToday(fromPhone);
  if (today >= pendingClaimDailyCap()) {
    throw new Error(
      `Pending-claim daily cap (${pendingClaimDailyCap()}) reached — prevents wallet-mint griefing`,
    );
  }
}

export async function holdPendingClaim(params: {
  fromPhone: string;
  toPhone: string;
  amountUsdc: number;
  idemKey: string;
}): Promise<{ claim: PendingClaim; txHash: string; explorer: string }> {
  await assertCanOpenPendingClaim(params.fromPhone);
  const to = await escrowAddress();
  const { txHash, explorer } = await transferUsdc({
    fromPhone: params.fromPhone,
    toAddress: to,
    amountUsdc: params.amountUsdc,
  });
  const expires = new Date(Date.now() + pendingClaimDays() * 86_400_000).toISOString();
  const claim = await createPendingClaim({
    from_phone: params.fromPhone,
    to_phone: params.toPhone,
    amount_usdc: params.amountUsdc,
    expires_at: expires,
    hold_tx_hash: txHash,
  });
  await addLedger({
    phone: params.fromPhone,
    kind: "escrow_hold",
    amount_usdc: params.amountUsdc,
    counterparty: params.toPhone,
    tx_hash: txHash,
    meta: JSON.stringify({ claimId: claim.id, idemKey: params.idemKey }),
  });
  log.info("pending claim held", {
    claimId: claim.id,
    from: shortHash(params.fromPhone),
    to: shortHash(params.toPhone),
    amount: params.amountUsdc,
  });
  return { claim, txHash, explorer };
}

/** On successful onboard — move escrow → new wallet for held claims. */
export async function fulfillPendingClaimsFor(payeePhone: string): Promise<number> {
  const phone = normalizePhone(payeePhone);
  const held = await listHeldClaimsForPayee(phone);
  if (!held.length) return 0;
  const user = await getUser(phone);
  if (!user) return 0;
  await ensureEscrowWallet();
  let n = 0;
  for (const c of held) {
    try {
      const { txHash } = await transferUsdc({
        fromPhone: ESCROW_ACCOUNT(),
        toAddress: user.wallet_address as Address,
        amountUsdc: c.amount_usdc,
      });
      await markPendingClaim(c.id, "claimed", txHash);
      await addLedger({
        phone,
        kind: "escrow_claim",
        amount_usdc: c.amount_usdc,
        counterparty: c.from_phone,
        tx_hash: txHash,
        meta: JSON.stringify({ claimId: c.id }),
      });
      n++;
    } catch (e) {
      log.warn("pending claim fulfill failed", { claimId: c.id, err: String(e) });
    }
  }
  if (n) log.info("pending claims fulfilled", { phone: shortHash(phone), count: n });
  return n;
}

/** Expire held claims past expires_at — refund escrow → sender. */
export async function expirePendingClaims(now = new Date()): Promise<number> {
  const { listExpiredHeldClaims } = await import("./db.js");
  const expired = await listExpiredHeldClaims(now.toISOString());
  await ensureEscrowWallet();
  let n = 0;
  for (const c of expired) {
    try {
      const sender = await getUser(c.from_phone);
      if (!sender) {
        await markPendingClaim(c.id, "expired");
        continue;
      }
      const { txHash } = await transferUsdc({
        fromPhone: ESCROW_ACCOUNT(),
        toAddress: sender.wallet_address as Address,
        amountUsdc: c.amount_usdc,
      });
      await markPendingClaim(c.id, "refunded", txHash);
      await addLedger({
        phone: c.from_phone,
        kind: "escrow_refund",
        amount_usdc: c.amount_usdc,
        counterparty: c.to_phone,
        tx_hash: txHash,
        meta: JSON.stringify({ claimId: c.id }),
      });
      n++;
    } catch (e) {
      log.warn("pending claim expire failed", { claimId: c.id, err: String(e) });
    }
  }
  return n;
}
