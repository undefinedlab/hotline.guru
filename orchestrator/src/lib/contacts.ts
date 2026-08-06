import { isAddress, type Address } from "viem";
import { getContact, getUser, getUserByHotlineName, normalizePhone } from "./db.js";
import { displayHotline, normalizeHotlineLabel } from "./hotlinens.js";
import { ensureWallet } from "./wallets.js";

export type ResolvedPayee = {
  label: string;
  /** Null when destination is an unknown MSISDN → pending-claim escrow path */
  address: Address | null;
  phone?: string;
  /** @deprecated unconsented wallet mint removed — always false for new unknowns */
  provisioned: boolean;
  pendingClaim?: boolean;
};

function looksLikePhone(raw: string): boolean {
  const d = raw.replace(/\D/g, "");
  return raw.startsWith("+") || (d.length >= 7 && d.length <= 15 && !raw.startsWith("0x"));
}

function looksLikeHotline(raw: string): boolean {
  if (/\.hotline$/i.test(raw)) return true;
  const n = normalizeHotlineLabel(raw);
  return n.length >= 2 && /^[a-z][a-z0-9-]*$/.test(n) && !looksLikePhone(raw);
}

export async function resolvePayee(fromPhone: string, to: string): Promise<ResolvedPayee | null> {
  const raw = to.trim();
  if (isAddress(raw)) {
    return { label: raw, address: raw, provisioned: false };
  }

  const contact = await getContact(fromPhone, raw);
  if (contact?.contact_address && isAddress(contact.contact_address)) {
    return {
      label: contact.contact_name,
      address: contact.contact_address as Address,
      provisioned: false,
    };
  }
  if (contact?.contact_phone) {
    const phone = normalizePhone(contact.contact_phone);
    const u = await getUser(phone);
    if (u) {
      return {
        label: contact.contact_name,
        address: u.wallet_address as Address,
        phone,
        provisioned: false,
      };
    }
    return {
      label: contact.contact_name,
      address: null,
      phone,
      provisioned: false,
      pendingClaim: true,
    };
  }

  if (looksLikePhone(raw)) {
    const phone = normalizePhone(raw);
    const u = await getUser(phone);
    if (u) {
      return {
        label: phone,
        address: u.wallet_address as Address,
        phone,
        provisioned: false,
      };
    }
    // Unknown MSISDN — do NOT mint a custodial wallet. Pending claim / escrow.
    return {
      label: phone,
      address: null,
      phone,
      provisioned: false,
      pendingClaim: true,
    };
  }

  if (looksLikeHotline(raw)) {
    const byNs = await getUserByHotlineName(normalizeHotlineLabel(raw));
    if (byNs) {
      return {
        label: displayHotline(byNs.hotline_name ?? raw),
        address: byNs.wallet_address as Address,
        phone: byNs.phone,
        provisioned: false,
      };
    }
  }

  return null;
}

/** Only used when we intentionally create a wallet (caller onboard / escrow). */
export { ensureWallet };
