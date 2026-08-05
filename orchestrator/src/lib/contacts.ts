import { isAddress, type Address } from "viem";
import { findUserByName, getContact, getUser, getUserByHotlineName, normalizePhone } from "./db.js";
import { displayHotline, normalizeHotlineLabel } from "./hotlinens.js";
import { ensureWallet } from "./wallets.js";

export type ResolvedPayee = {
  label: string;
  address: Address;
  phone?: string;
  provisioned: boolean;
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
    const existed = !!(await getUser(phone));
    const u = existed ? (await getUser(phone))! : await ensureWallet(phone);
    return {
      label: contact.contact_name,
      address: u.wallet_address as Address,
      phone,
      provisioned: !existed,
    };
  }

  if (looksLikePhone(raw)) {
    const phone = normalizePhone(raw);
    const existed = !!(await getUser(phone));
    const u = existed ? (await getUser(phone))! : await ensureWallet(phone);
    return {
      label: phone,
      address: u.wallet_address as Address,
      phone,
      provisioned: !existed,
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

  const byName = await findUserByName(raw.replace(/\.hotline$/i, ""));
  if (byName) {
    return {
      label: byName.hotline_name
        ? displayHotline(byName.hotline_name)
        : (byName.name ?? raw),
      address: byName.wallet_address as Address,
      phone: byName.phone,
      provisioned: false,
    };
  }

  return null;
}
