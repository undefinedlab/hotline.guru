import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dbPath = process.env.DATABASE_PATH ?? "./data/hotline.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  name TEXT,
  pin_hash TEXT,
  wallet_address TEXT NOT NULL,
  wallet_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  phone TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_phone TEXT,
  contact_address TEXT,
  PRIMARY KEY (phone, contact_name)
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_usdc REAL NOT NULL,
  counterparty TEXT,
  tx_hash TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  phone TEXT PRIMARY KEY,
  pending_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export type User = {
  phone: string;
  name: string | null;
  pin_hash: string | null;
  wallet_address: string;
  wallet_ref: string;
  created_at: string;
};

export function getUser(phone: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE phone = ?").get(normalizePhone(phone)) as
    | User
    | undefined;
}

export function upsertUser(u: {
  phone: string;
  name?: string | null;
  pin_hash?: string | null;
  wallet_address: string;
  wallet_ref: string;
}): User {
  const phone = normalizePhone(u.phone);
  db.prepare(
    `INSERT INTO users (phone, name, pin_hash, wallet_address, wallet_ref)
     VALUES (@phone, @name, @pin_hash, @wallet_address, @wallet_ref)
     ON CONFLICT(phone) DO UPDATE SET
       name = COALESCE(excluded.name, users.name),
       pin_hash = COALESCE(excluded.pin_hash, users.pin_hash),
       wallet_address = excluded.wallet_address,
       wallet_ref = excluded.wallet_ref`,
  ).run({
    phone,
    name: u.name ?? null,
    pin_hash: u.pin_hash ?? null,
    wallet_address: u.wallet_address,
    wallet_ref: u.wallet_ref,
  });
  return getUser(phone)!;
}

export function setPin(phone: string, pinHash: string) {
  db.prepare("UPDATE users SET pin_hash = ? WHERE phone = ?").run(pinHash, normalizePhone(phone));
}

export function saveContact(
  phone: string,
  contactName: string,
  opts: { contactPhone?: string; contactAddress?: string },
) {
  db.prepare(
    `INSERT INTO contacts (phone, contact_name, contact_phone, contact_address)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(phone, contact_name) DO UPDATE SET
       contact_phone = COALESCE(excluded.contact_phone, contacts.contact_phone),
       contact_address = COALESCE(excluded.contact_address, contacts.contact_address)`,
  ).run(
    normalizePhone(phone),
    contactName.toLowerCase(),
    opts.contactPhone ?? null,
    opts.contactAddress ?? null,
  );
}

export function getContact(phone: string, contactName: string) {
  return db
    .prepare("SELECT * FROM contacts WHERE phone = ? AND contact_name = ?")
    .get(normalizePhone(phone), contactName.toLowerCase()) as
    | {
        phone: string;
        contact_name: string;
        contact_phone: string | null;
        contact_address: string | null;
      }
    | undefined;
}

export function listContacts(phone: string) {
  return db
    .prepare("SELECT * FROM contacts WHERE phone = ? ORDER BY contact_name")
    .all(normalizePhone(phone));
}

export function addLedger(entry: {
  phone: string;
  kind: string;
  amount_usdc: number;
  counterparty?: string;
  tx_hash?: string;
  meta?: string;
}) {
  db.prepare(
    `INSERT INTO ledger (phone, kind, amount_usdc, counterparty, tx_hash, meta)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    normalizePhone(entry.phone),
    entry.kind,
    entry.amount_usdc,
    entry.counterparty ?? null,
    entry.tx_hash ?? null,
    entry.meta ?? null,
  );
}

export function listLedger(phone: string, limit = 10) {
  return db
    .prepare(
      `SELECT id, kind, amount_usdc, counterparty, tx_hash, created_at
       FROM ledger WHERE phone = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(normalizePhone(phone), limit) as {
    id: number;
    kind: string;
    amount_usdc: number;
    counterparty: string | null;
    tx_hash: string | null;
    created_at: string;
  }[];
}

export function sumLedgerToday(phone: string, kindPrefix?: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM ledger
       WHERE phone = ? AND date(created_at) = date('now')
       ${kindPrefix ? "AND kind LIKE ?" : ""}`,
    )
    .get(
      ...(kindPrefix
        ? [normalizePhone(phone), `${kindPrefix}%`]
        : [normalizePhone(phone)]),
    ) as { total: number };
  return row.total;
}

export function setUserName(phone: string, name: string) {
  const cleaned = name.trim().replace(/\s+/g, " ");
  const pretty = cleaned
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
  db.prepare("UPDATE users SET name = ? WHERE phone = ?").run(pretty, normalizePhone(phone));
  return getUser(phone)!;
}

export function setPending(phone: string, pending: unknown | null) {
  const p = normalizePhone(phone);
  if (pending == null) {
    db.prepare("DELETE FROM sessions WHERE phone = ?").run(p);
    return;
  }
  db.prepare(
    `INSERT INTO sessions (phone, pending_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(phone) DO UPDATE SET pending_json = excluded.pending_json, updated_at = datetime('now')`,
  ).run(p, JSON.stringify(pending));
}

export function getPending<T = unknown>(phone: string): T | null {
  const row = db.prepare("SELECT pending_json FROM sessions WHERE phone = ?").get(normalizePhone(phone)) as
    | { pending_json: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.pending_json) as T;
}

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  return digits.startsWith("00") ? `+${digits.slice(2)}` : `+${digits}`;
}

export function findUserByName(name: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE lower(name) = lower(?)").get(name) as User | undefined;
}

export function findUserByAddress(address: string): User | undefined {
  return db
    .prepare("SELECT * FROM users WHERE lower(wallet_address) = lower(?)")
    .get(address) as User | undefined;
}
