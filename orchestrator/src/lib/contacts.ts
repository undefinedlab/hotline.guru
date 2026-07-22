import { isAddress, type Address } from "viem";
import { findUserByName, getContact, getUser, normalizePhone } from "./db.js";
import { ensureWallet } from "./wallets.js";

export type ResolvedPayee = {
  label: string;
  address: Address;
};

function looksLikePhone(raw: string): boolean {
  const d = raw.replace(/\D/g, "");
  return raw.startsWith("+") || (d.length >= 7 && d.length <= 15 && !raw.startsWith("0x"));
}

/** Resolve contact name, phone number, another user, or 0x address. */
export async function resolvePayee(fromPhone: string, to: string): Promise<ResolvedPayee | null> {
  const raw = to.trim();
  if (isAddress(raw)) {
    return { label: raw, address: raw };
  }

  const contact = getContact(fromPhone, raw);
  if (contact?.contact_address && isAddress(contact.contact_address)) {
    return { label: contact.contact_name, address: contact.contact_address as Address };
  }
  if (contact?.contact_phone) {
    const u = getUser(contact.contact_phone) ?? (await ensureWallet(contact.contact_phone));
    return { label: contact.contact_name, address: u.wallet_address as Address };
  }

  if (looksLikePhone(raw)) {
    const phone = normalizePhone(raw);
    const u = getUser(phone) ?? (await ensureWallet(phone));
    return { label: phone, address: u.wallet_address as Address };
  }

  const byName = findUserByName(raw.replace(/\.hotline$/i, ""));
  if (byName) {
    return { label: byName.name ?? raw, address: byName.wallet_address as Address };
  }

  return null;
}
