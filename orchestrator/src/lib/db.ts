/**
 * Dual store: SQLite (local/tests) or Postgres (Docker / staging).
 * Set DATABASE_URL=postgres://... for Postgres; else DATABASE_PATH for SQLite.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import pg from "pg";

export type SimAttestStatus = "none" | "pending" | "attested" | "failed";

export type User = {
  phone: string;
  name: string | null;
  pin_hash: string | null;
  wallet_address: string;
  wallet_ref: string;
  pin_fail_count: number;
  pin_locked_until: string | null;
  identity_tier: number;
  national_id_hash: string | null;
  sim_attest_status: SimAttestStatus;
  sim_attest_provider: string | null;
  sim_attest_at: string | null;
  hotline_name: string | null;
  risk_cooldown_until: string | null;
  callback_verified_until: string | null;
  recovery_code_hash: string | null;
  recovery_expires_at: string | null;
  created_at: string;
};

const DATABASE_URL = process.env.DATABASE_URL ?? "";
export const usingPostgres = Boolean(DATABASE_URL);

let sqlite: Database.Database | null = null;
let pool: pg.Pool | null = null;
let ready: Promise<void> | null = null;

function sqliteDb(): Database.Database {
  if (sqlite) return sqlite;
  const dbPath = process.env.DATABASE_PATH ?? "./data/hotline.db";
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  migrateSqlite(sqlite);
  return sqlite;
}

function migrateSqlite(db: Database.Database) {
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  name TEXT,
  pin_hash TEXT,
  wallet_address TEXT NOT NULL,
  wallet_ref TEXT NOT NULL,
  pin_fail_count INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TEXT,
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
CREATE TABLE IF NOT EXISTS idempotency (
  id_key TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS policy_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  action TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT,
  amount_usdc REAL,
  payee TEXT,
  intent_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS hotline_names (
  name TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pending_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_phone TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  amount_usdc REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',
  hold_tx_hash TEXT,
  settle_tx_hash TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS pending_claims_to_status ON pending_claims (to_phone, status);
CREATE INDEX IF NOT EXISTS pending_claims_from_created ON pending_claims (from_phone, created_at);
CREATE TABLE IF NOT EXISTS user_policy_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  rule_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  max_usdc REAL,
  label TEXT,
  spoken TEXT NOT NULL,
  readback TEXT NOT NULL,
  rules_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS user_policy_rules_phone ON user_policy_rules (phone, status);
CREATE TABLE IF NOT EXISTS standing_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  amount_usdc REAL NOT NULL,
  to_label TEXT NOT NULL,
  to_phone TEXT,
  to_address TEXT,
  cadence TEXT NOT NULL,
  next_run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_idem TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS standing_orders_next ON standing_orders (status, next_run_at);
CREATE TABLE IF NOT EXISTS savings_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  amount_usdc REAL NOT NULL,
  unlock_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS savings_locks_phone ON savings_locks (phone, status);
CREATE TABLE IF NOT EXISTS account_links (
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, external_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS account_links_channel_phone ON account_links (channel, phone);
CREATE INDEX IF NOT EXISTS account_links_phone ON account_links (phone);
`);
  ensureUserColumnsSqlite(db);
  ensurePolicyAuditHashSqlite(db);
}

function ensurePolicyAuditHashSqlite(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(policy_audit)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("prev_hash")) db.exec("ALTER TABLE policy_audit ADD COLUMN prev_hash TEXT");
  if (!names.has("entry_hash")) db.exec("ALTER TABLE policy_audit ADD COLUMN entry_hash TEXT");
}

function ensureUserColumnsSqlite(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  const add = (col: string, ddl: string) => {
    if (!names.has(col)) db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
  };
  add("pin_fail_count", "pin_fail_count INTEGER NOT NULL DEFAULT 0");
  add("pin_locked_until", "pin_locked_until TEXT");
  add("identity_tier", "identity_tier INTEGER NOT NULL DEFAULT 0");
  add("national_id_hash", "national_id_hash TEXT");
  add("sim_attest_status", "sim_attest_status TEXT NOT NULL DEFAULT 'none'");
  add("sim_attest_provider", "sim_attest_provider TEXT");
  add("sim_attest_at", "sim_attest_at TEXT");
  add("hotline_name", "hotline_name TEXT");
  add("risk_cooldown_until", "risk_cooldown_until TEXT");
  add("callback_verified_until", "callback_verified_until TEXT");
  add("recovery_code_hash", "recovery_code_hash TEXT");
  add("recovery_expires_at", "recovery_expires_at TEXT");
}

async function migratePostgres(client: pg.Pool) {
  await client.query(`
CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  name TEXT,
  pin_hash TEXT,
  wallet_address TEXT NOT NULL,
  wallet_ref TEXT NOT NULL,
  pin_fail_count INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS contacts (
  phone TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_phone TEXT,
  contact_address TEXT,
  PRIMARY KEY (phone, contact_name)
);
CREATE TABLE IF NOT EXISTS ledger (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_usdc DOUBLE PRECISION NOT NULL,
  counterparty TEXT,
  tx_hash TEXT,
  meta TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sessions (
  phone TEXT PRIMARY KEY,
  pending_json TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS idempotency (
  id_key TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS policy_audit (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  action TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT,
  amount_usdc DOUBLE PRECISION,
  payee TEXT,
  intent_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ledger_phone_created ON ledger (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS policy_audit_phone_created ON policy_audit (phone, created_at DESC);
CREATE TABLE IF NOT EXISTS hotline_names (
  name TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS pending_claims (
  id BIGSERIAL PRIMARY KEY,
  from_phone TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  amount_usdc DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',
  hold_tx_hash TEXT,
  settle_tx_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pending_claims_to_status ON pending_claims (to_phone, status);
CREATE TABLE IF NOT EXISTS user_policy_rules (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  rule_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  max_usdc DOUBLE PRECISION,
  label TEXT,
  spoken TEXT NOT NULL,
  readback TEXT NOT NULL,
  rules_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_policy_rules_phone ON user_policy_rules (phone, status);
CREATE TABLE IF NOT EXISTS standing_orders (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  amount_usdc DOUBLE PRECISION NOT NULL,
  to_label TEXT NOT NULL,
  to_phone TEXT,
  to_address TEXT,
  cadence TEXT NOT NULL,
  next_run_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_idem TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS standing_orders_next ON standing_orders (status, next_run_at);
CREATE TABLE IF NOT EXISTS savings_locks (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  amount_usdc DOUBLE PRECISION NOT NULL,
  unlock_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS savings_locks_phone ON savings_locks (phone, status);
CREATE TABLE IF NOT EXISTS account_links (
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel, external_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS account_links_channel_phone ON account_links (channel, phone);
CREATE INDEX IF NOT EXISTS account_links_phone ON account_links (phone);
`);
  await client.query(`
ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_tier INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS national_id_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sim_attest_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE users ADD COLUMN IF NOT EXISTS sim_attest_provider TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sim_attest_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hotline_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_cooldown_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS callback_verified_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_code_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_expires_at TIMESTAMPTZ;
ALTER TABLE policy_audit ADD COLUMN IF NOT EXISTS prev_hash TEXT;
ALTER TABLE policy_audit ADD COLUMN IF NOT EXISTS entry_hash TEXT;
`);
}

/** Call once at process start (HTTP server / tests). */
export async function initDb(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    if (usingPostgres) {
      pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
      await migratePostgres(pool);
    } else {
      sqliteDb();
    }
  })();
  return ready;
}

export async function checkDb(): Promise<{ ok: boolean; driver: string; error?: string }> {
  try {
    await initDb();
    if (usingPostgres) {
      await pool!.query("SELECT 1");
      return { ok: true, driver: "postgres" };
    }
    sqliteDb().prepare("SELECT 1").get();
    return { ok: true, driver: "sqlite" };
  } catch (e) {
    return { ok: false, driver: usingPostgres ? "postgres" : "sqlite", error: String(e) };
  }
}

export function normalizePhone(phone: string): string {
  const raw = phone.trim();
  // Telegram / explicit channel accounts — do not coerce to +E.164
  if (/^tg:/i.test(raw)) {
    const id = raw.replace(/^tg:/i, "").replace(/[^\d-]/g, "");
    return `tg:${id}`;
  }
  if (/^(telegram):/i.test(raw)) {
    const id = raw.replace(/^(telegram):/i, "").replace(/[^\d-]/g, "");
    return `tg:${id}`;
  }
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  return digits.startsWith("00") ? `+${digits.slice(2)}` : `+${digits}`;
}

function mapUser(row: Record<string, unknown> | undefined): User | undefined {
  if (!row) return undefined;
  const sim = String(row.sim_attest_status ?? "none") as SimAttestStatus;
  return {
    phone: String(row.phone),
    name: (row.name as string) ?? null,
    pin_hash: (row.pin_hash as string) ?? null,
    wallet_address: String(row.wallet_address),
    wallet_ref: String(row.wallet_ref),
    pin_fail_count: Number(row.pin_fail_count ?? 0),
    pin_locked_until: row.pin_locked_until ? String(row.pin_locked_until) : null,
    identity_tier: Number(row.identity_tier ?? 0),
    national_id_hash: (row.national_id_hash as string) ?? null,
    sim_attest_status: ["none", "pending", "attested", "failed"].includes(sim) ? sim : "none",
    sim_attest_provider: (row.sim_attest_provider as string) ?? null,
    sim_attest_at: row.sim_attest_at ? String(row.sim_attest_at) : null,
    hotline_name: (row.hotline_name as string) ?? null,
    risk_cooldown_until: row.risk_cooldown_until ? String(row.risk_cooldown_until) : null,
    callback_verified_until: row.callback_verified_until
      ? String(row.callback_verified_until)
      : null,
    recovery_code_hash: (row.recovery_code_hash as string) ?? null,
    recovery_expires_at: row.recovery_expires_at ? String(row.recovery_expires_at) : null,
    created_at: String(row.created_at),
  };
}

export async function getUser(phone: string): Promise<User | undefined> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    const r = await pool!.query("SELECT * FROM users WHERE phone = $1", [p]);
    return mapUser(r.rows[0]);
  }
  return mapUser(sqliteDb().prepare("SELECT * FROM users WHERE phone = ?").get(p) as Record<string, unknown>);
}

export async function upsertUser(u: {
  phone: string;
  name?: string | null;
  pin_hash?: string | null;
  wallet_address: string;
  wallet_ref: string;
}): Promise<User> {
  await initDb();
  const phone = normalizePhone(u.phone);
  if (usingPostgres) {
    await pool!.query(
      `INSERT INTO users (phone, name, pin_hash, wallet_address, wallet_ref)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(phone) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, users.name),
         pin_hash = COALESCE(EXCLUDED.pin_hash, users.pin_hash),
         wallet_address = EXCLUDED.wallet_address,
         wallet_ref = EXCLUDED.wallet_ref`,
      [phone, u.name ?? null, u.pin_hash ?? null, u.wallet_address, u.wallet_ref],
    );
  } else {
    sqliteDb()
      .prepare(
        `INSERT INTO users (phone, name, pin_hash, wallet_address, wallet_ref)
         VALUES (@phone, @name, @pin_hash, @wallet_address, @wallet_ref)
         ON CONFLICT(phone) DO UPDATE SET
           name = COALESCE(excluded.name, users.name),
           pin_hash = COALESCE(excluded.pin_hash, users.pin_hash),
           wallet_address = excluded.wallet_address,
           wallet_ref = excluded.wallet_ref`,
      )
      .run({
        phone,
        name: u.name ?? null,
        pin_hash: u.pin_hash ?? null,
        wallet_address: u.wallet_address,
        wallet_ref: u.wallet_ref,
      });
  }
  return (await getUser(phone))!;
}

export async function setPin(phone: string, pinHash: string): Promise<void> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    await pool!.query(
      `UPDATE users SET pin_hash = $1, pin_fail_count = 0, pin_locked_until = NULL WHERE phone = $2`,
      [pinHash, p],
    );
  } else {
    sqliteDb()
      .prepare(
        `UPDATE users SET pin_hash = ?, pin_fail_count = 0, pin_locked_until = NULL WHERE phone = ?`,
      )
      .run(pinHash, p);
  }
}

export async function recordPinFailure(phone: string, maxFails = 5, lockMinutes = 15): Promise<User> {
  await initDb();
  const p = normalizePhone(phone);
  const user = (await getUser(p))!;
  const fails = (user.pin_fail_count ?? 0) + 1;
  const locked =
    fails >= maxFails ? new Date(Date.now() + lockMinutes * 60_000).toISOString() : null;
  if (usingPostgres) {
    await pool!.query(
      `UPDATE users SET pin_fail_count = $1, pin_locked_until = $2 WHERE phone = $3`,
      [fails, locked, p],
    );
  } else {
    sqliteDb()
      .prepare(`UPDATE users SET pin_fail_count = ?, pin_locked_until = ? WHERE phone = ?`)
      .run(fails, locked, p);
  }
  return (await getUser(p))!;
}

export async function clearPinFailures(phone: string): Promise<void> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    await pool!.query(
      `UPDATE users SET pin_fail_count = 0, pin_locked_until = NULL WHERE phone = $1`,
      [p],
    );
  } else {
    sqliteDb()
      .prepare(`UPDATE users SET pin_fail_count = 0, pin_locked_until = NULL WHERE phone = ?`)
      .run(p);
  }
}

export function isPinLocked(user: User): boolean {
  if (!user.pin_locked_until) return false;
  return Date.parse(user.pin_locked_until) > Date.now();
}

export async function saveContact(
  phone: string,
  contactName: string,
  opts: { contactPhone?: string; contactAddress?: string },
): Promise<void> {
  await initDb();
  const p = normalizePhone(phone);
  const name = contactName.toLowerCase();
  if (usingPostgres) {
    await pool!.query(
      `INSERT INTO contacts (phone, contact_name, contact_phone, contact_address)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(phone, contact_name) DO UPDATE SET
         contact_phone = COALESCE(EXCLUDED.contact_phone, contacts.contact_phone),
         contact_address = COALESCE(EXCLUDED.contact_address, contacts.contact_address)`,
      [p, name, opts.contactPhone ?? null, opts.contactAddress ?? null],
    );
  } else {
    sqliteDb()
      .prepare(
        `INSERT INTO contacts (phone, contact_name, contact_phone, contact_address)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(phone, contact_name) DO UPDATE SET
           contact_phone = COALESCE(excluded.contact_phone, contacts.contact_phone),
           contact_address = COALESCE(excluded.contact_address, contacts.contact_address)`,
      )
      .run(p, name, opts.contactPhone ?? null, opts.contactAddress ?? null);
  }
}

export async function getContact(phone: string, contactName: string) {
  await initDb();
  const p = normalizePhone(phone);
  const name = contactName.toLowerCase();
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT * FROM contacts WHERE phone = $1 AND contact_name = $2`,
      [p, name],
    );
    return r.rows[0] as
      | {
          phone: string;
          contact_name: string;
          contact_phone: string | null;
          contact_address: string | null;
        }
      | undefined;
  }
  return sqliteDb()
    .prepare("SELECT * FROM contacts WHERE phone = ? AND contact_name = ?")
    .get(p, name) as
    | {
        phone: string;
        contact_name: string;
        contact_phone: string | null;
        contact_address: string | null;
      }
    | undefined;
}

export async function listContacts(phone: string) {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT * FROM contacts WHERE phone = $1 ORDER BY contact_name`,
      [p],
    );
    return r.rows;
  }
  return sqliteDb()
    .prepare("SELECT * FROM contacts WHERE phone = ? ORDER BY contact_name")
    .all(p);
}

export async function addLedger(entry: {
  phone: string;
  kind: string;
  amount_usdc: number;
  counterparty?: string;
  tx_hash?: string;
  meta?: string;
}): Promise<void> {
  await initDb();
  const p = normalizePhone(entry.phone);
  if (usingPostgres) {
    await pool!.query(
      `INSERT INTO ledger (phone, kind, amount_usdc, counterparty, tx_hash, meta)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        p,
        entry.kind,
        entry.amount_usdc,
        entry.counterparty ?? null,
        entry.tx_hash ?? null,
        entry.meta ?? null,
      ],
    );
  } else {
    sqliteDb()
      .prepare(
        `INSERT INTO ledger (phone, kind, amount_usdc, counterparty, tx_hash, meta)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p,
        entry.kind,
        entry.amount_usdc,
        entry.counterparty ?? null,
        entry.tx_hash ?? null,
        entry.meta ?? null,
      );
  }
}

export async function listLedger(phone: string, limit = 10) {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT id, kind, amount_usdc, counterparty, tx_hash, created_at
       FROM ledger WHERE phone = $1 ORDER BY id DESC LIMIT $2`,
      [p, limit],
    );
    return r.rows as {
      id: number;
      kind: string;
      amount_usdc: number;
      counterparty: string | null;
      tx_hash: string | null;
      created_at: string;
    }[];
  }
  return sqliteDb()
    .prepare(
      `SELECT id, kind, amount_usdc, counterparty, tx_hash, created_at
       FROM ledger WHERE phone = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(p, limit) as {
    id: number;
    kind: string;
    amount_usdc: number;
    counterparty: string | null;
    tx_hash: string | null;
    created_at: string;
  }[];
}

export async function sumLedgerToday(phone: string, kindPrefix?: string): Promise<number> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    const r = kindPrefix
      ? await pool!.query(
          `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM ledger
           WHERE phone = $1 AND created_at::date = CURRENT_DATE AND kind LIKE $2`,
          [p, `${kindPrefix}%`],
        )
      : await pool!.query(
          `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM ledger
           WHERE phone = $1 AND created_at::date = CURRENT_DATE`,
          [p],
        );
    return Number(r.rows[0].total);
  }
  const row = sqliteDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM ledger
       WHERE phone = ? AND date(created_at) = date('now')
       ${kindPrefix ? "AND kind LIKE ?" : ""}`,
    )
    .get(...(kindPrefix ? [p, `${kindPrefix}%`] : [p])) as { total: number };
  return row.total;
}

export async function setUserName(phone: string, name: string): Promise<User> {
  await initDb();
  const cleaned = name.trim().replace(/\s+/g, " ");
  const pretty = cleaned
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
  const p = normalizePhone(phone);
  if (usingPostgres) {
    await pool!.query(`UPDATE users SET name = $1 WHERE phone = $2`, [pretty, p]);
  } else {
    sqliteDb().prepare("UPDATE users SET name = ? WHERE phone = ?").run(pretty, p);
  }
  return (await getUser(p))!;
}

export async function setIdentityFields(
  phone: string,
  fields: {
    identity_tier?: number;
    national_id_hash?: string | null;
    sim_attest_status?: SimAttestStatus;
    sim_attest_provider?: string | null;
    sim_attest_at?: string | null;
    hotline_name?: string | null;
  },
): Promise<User> {
  await initDb();
  const p = normalizePhone(phone);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, val: unknown) => {
    if (usingPostgres) {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    } else {
      sets.push(`${col} = ?`);
      vals.push(val);
    }
  };
  if (fields.identity_tier !== undefined) push("identity_tier", fields.identity_tier);
  if (fields.national_id_hash !== undefined) push("national_id_hash", fields.national_id_hash);
  if (fields.sim_attest_status !== undefined) push("sim_attest_status", fields.sim_attest_status);
  if (fields.sim_attest_provider !== undefined)
    push("sim_attest_provider", fields.sim_attest_provider);
  if (fields.sim_attest_at !== undefined) push("sim_attest_at", fields.sim_attest_at);
  if (fields.hotline_name !== undefined) push("hotline_name", fields.hotline_name);
  if (!sets.length) return (await getUser(p))!;
  if (usingPostgres) {
    vals.push(p);
    await pool!.query(`UPDATE users SET ${sets.join(", ")} WHERE phone = $${vals.length}`, vals);
  } else {
    vals.push(p);
    sqliteDb().prepare(`UPDATE users SET ${sets.join(", ")} WHERE phone = ?`).run(...vals);
  }
  return (await getUser(p))!;
}

export type HotlineNameRow = { name: string; phone: string; created_at: string };

export async function getHotlineName(name: string): Promise<HotlineNameRow | undefined> {
  await initDb();
  const n = name.trim().toLowerCase();
  if (usingPostgres) {
    const r = await pool!.query(`SELECT * FROM hotline_names WHERE name = $1`, [n]);
    const row = r.rows[0];
    if (!row) return undefined;
    return { name: String(row.name), phone: String(row.phone), created_at: String(row.created_at) };
  }
  const row = sqliteDb().prepare("SELECT * FROM hotline_names WHERE name = ?").get(n) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return { name: String(row.name), phone: String(row.phone), created_at: String(row.created_at) };
}

export async function getUserByHotlineName(name: string): Promise<User | undefined> {
  const row = await getHotlineName(name);
  if (!row) return undefined;
  return getUser(row.phone);
}

/** Unique onboarded user by first name (case-insensitive). Null if 0 or 2+ matches. */
export async function findUniqueUserByFirstName(raw: string): Promise<User | undefined> {
  await initDb();
  const needle = raw.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (needle.length < 2) return undefined;
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT * FROM users
       WHERE name IS NOT NULL
         AND lower(split_part(name, ' ', 1)) = $1
         AND phone LIKE '+%'
         AND pin_hash IS NOT NULL`,
      [needle],
    );
    if (r.rows.length !== 1) return undefined;
    return mapUser(r.rows[0] as Record<string, unknown>);
  }
  const rows = sqliteDb()
    .prepare(
      `SELECT * FROM users
       WHERE name IS NOT NULL
         AND lower(substr(name, 1, instr(name || ' ', ' ') - 1)) = ?
         AND phone LIKE '+%'
         AND pin_hash IS NOT NULL`,
    )
    .all(needle) as Record<string, unknown>[];
  if (rows.length !== 1) return undefined;
  return mapUser(rows[0]);
}

/** Claim or re-claim a HotlineNS label for this phone. */
export async function claimHotlineName(phone: string, name: string): Promise<User> {
  await initDb();
  const p = normalizePhone(phone);
  const n = name.trim().toLowerCase();
  const user = await getUser(p);
  if (!user) throw new Error("User not found");

  const existing = await getHotlineName(n);
  if (existing && existing.phone !== p) {
    throw new Error("name taken");
  }

  if (usingPostgres) {
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM hotline_names WHERE phone = $1`, [p]);
      await client.query(`INSERT INTO hotline_names (name, phone) VALUES ($1, $2)`, [n, p]);
      await client.query(`UPDATE users SET hotline_name = $1 WHERE phone = $2`, [n, p]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } else {
    const db = sqliteDb();
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM hotline_names WHERE phone = ?").run(p);
      db.prepare("INSERT INTO hotline_names (name, phone) VALUES (?, ?)").run(n, p);
      db.prepare("UPDATE users SET hotline_name = ? WHERE phone = ?").run(n, p);
    });
    tx();
  }
  return (await getUser(p))!;
}

export async function releaseHotlineName(phone: string): Promise<User> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    await pool!.query(`DELETE FROM hotline_names WHERE phone = $1`, [p]);
    await pool!.query(`UPDATE users SET hotline_name = NULL WHERE phone = $1`, [p]);
  } else {
    sqliteDb().prepare("DELETE FROM hotline_names WHERE phone = ?").run(p);
    sqliteDb().prepare("UPDATE users SET hotline_name = NULL WHERE phone = ?").run(p);
  }
  return (await getUser(p))!;
}

export async function setPending(phone: string, pending: unknown | null): Promise<void> {
  await initDb();
  const p = normalizePhone(phone);
  if (pending == null) {
    if (usingPostgres) await pool!.query(`DELETE FROM sessions WHERE phone = $1`, [p]);
    else sqliteDb().prepare("DELETE FROM sessions WHERE phone = ?").run(p);
    return;
  }
  const json = JSON.stringify(pending);
  if (usingPostgres) {
    await pool!.query(
      `INSERT INTO sessions (phone, pending_json, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT(phone) DO UPDATE SET pending_json = EXCLUDED.pending_json, updated_at = NOW()`,
      [p, json],
    );
  } else {
    sqliteDb()
      .prepare(
        `INSERT INTO sessions (phone, pending_json, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(phone) DO UPDATE SET pending_json = excluded.pending_json, updated_at = datetime('now')`,
      )
      .run(p, json);
  }
}

export async function getPending<T = unknown>(phone: string): Promise<T | null> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    const r = await pool!.query(`SELECT pending_json FROM sessions WHERE phone = $1`, [p]);
    if (!r.rows[0]) return null;
    return JSON.parse(r.rows[0].pending_json) as T;
  }
  const row = sqliteDb()
    .prepare("SELECT pending_json FROM sessions WHERE phone = ?")
    .get(p) as { pending_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.pending_json) as T;
}

export async function findUserByName(name: string): Promise<User | undefined> {
  await initDb();
  if (usingPostgres) {
    const r = await pool!.query(`SELECT * FROM users WHERE lower(name) = lower($1)`, [name]);
    return mapUser(r.rows[0]);
  }
  return mapUser(
    sqliteDb().prepare("SELECT * FROM users WHERE lower(name) = lower(?)").get(name) as Record<
      string,
      unknown
    >,
  );
}

export async function findUserByAddress(address: string): Promise<User | undefined> {
  await initDb();
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT * FROM users WHERE lower(wallet_address) = lower($1)`,
      [address],
    );
    return mapUser(r.rows[0]);
  }
  return mapUser(
    sqliteDb()
      .prepare("SELECT * FROM users WHERE lower(wallet_address) = lower(?)")
      .get(address) as Record<string, unknown>,
  );
}

export async function getIdempotentResult<T = unknown>(
  idKey: string,
): Promise<T | null> {
  await initDb();
  if (usingPostgres) {
    const r = await pool!.query(`SELECT result_json FROM idempotency WHERE id_key = $1`, [idKey]);
    if (!r.rows[0]) return null;
    return JSON.parse(r.rows[0].result_json) as T;
  }
  const row = sqliteDb()
    .prepare("SELECT result_json FROM idempotency WHERE id_key = ?")
    .get(idKey) as { result_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.result_json) as T;
}

const IDEM_PENDING = '{"__idem":"pending"}';

function isIdemPending(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw != null &&
    (raw as { __idem?: string }).__idem === "pending"
  );
}

/**
 * Atomic claim before money move — winner transfers; loser sees inflight or completed.
 */
export async function claimIdempotency<T = unknown>(
  idKey: string,
  phone: string,
): Promise<
  | { status: "claimed" }
  | { status: "inflight" }
  | { status: "completed"; result: T }
> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    const ins = await pool!.query(
      `INSERT INTO idempotency (id_key, phone, result_json)
       VALUES ($1, $2, $3)
       ON CONFLICT (id_key) DO NOTHING
       RETURNING id_key`,
      [idKey, p, IDEM_PENDING],
    );
    if (ins.rowCount && ins.rowCount > 0) return { status: "claimed" };
  } else {
    const info = sqliteDb()
      .prepare(
        `INSERT OR IGNORE INTO idempotency (id_key, phone, result_json) VALUES (?, ?, ?)`,
      )
      .run(idKey, p, IDEM_PENDING);
    if (info.changes > 0) return { status: "claimed" };
  }
  const existing = await getIdempotentResult<T | { __idem: string }>(idKey);
  if (existing == null) return { status: "claimed" }; // race unlikely
  if (isIdemPending(existing)) return { status: "inflight" };
  return { status: "completed", result: existing as T };
}

export async function saveIdempotentResult(
  idKey: string,
  phone: string,
  result: unknown,
): Promise<void> {
  await initDb();
  const p = normalizePhone(phone);
  const json = JSON.stringify(result);
  if (usingPostgres) {
    await pool!.query(
      `INSERT INTO idempotency (id_key, phone, result_json)
       VALUES ($1, $2, $3)
       ON CONFLICT (id_key) DO UPDATE SET result_json = EXCLUDED.result_json, phone = EXCLUDED.phone`,
      [idKey, p, json],
    );
  } else {
    sqliteDb()
      .prepare(
        `INSERT INTO idempotency (id_key, phone, result_json) VALUES (?, ?, ?)
         ON CONFLICT(id_key) DO UPDATE SET result_json = excluded.result_json, phone = excluded.phone`,
      )
      .run(idKey, p, json);
  }
}

/** Append-only policy gate decision with hash-chain (tamper-evident). */
export async function recordPolicyDecision(entry: {
  phone: string;
  action: string;
  verdict: string;
  reason?: string;
  amount_usdc?: number;
  payee?: string;
  intent?: unknown;
}): Promise<void> {
  await initDb();
  const p = normalizePhone(entry.phone);
  const intentJson = entry.intent != null ? JSON.stringify(entry.intent) : null;
  const prev = await latestPolicyHash();
  const createdAt = new Date().toISOString();
  const entryHash = createHash("sha256")
    .update(
      [
        prev ?? "genesis",
        p,
        entry.action,
        entry.verdict,
        entry.reason ?? "",
        String(entry.amount_usdc ?? ""),
        entry.payee ?? "",
        intentJson ?? "",
        createdAt,
      ].join("|"),
    )
    .digest("hex");

  if (usingPostgres) {
    await pool!.query(
      `INSERT INTO policy_audit
         (phone, action, verdict, reason, amount_usdc, payee, intent_json, prev_hash, entry_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        p,
        entry.action,
        entry.verdict,
        entry.reason ?? null,
        entry.amount_usdc ?? null,
        entry.payee ?? null,
        intentJson,
        prev,
        entryHash,
        createdAt,
      ],
    );
  } else {
    sqliteDb()
      .prepare(
        `INSERT INTO policy_audit
           (phone, action, verdict, reason, amount_usdc, payee, intent_json, prev_hash, entry_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p,
        entry.action,
        entry.verdict,
        entry.reason ?? null,
        entry.amount_usdc ?? null,
        entry.payee ?? null,
        intentJson,
        prev,
        entryHash,
        createdAt,
      );
  }
}

async function latestPolicyHash(): Promise<string | null> {
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT entry_hash FROM policy_audit WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1`,
    );
    return r.rows[0]?.entry_hash ? String(r.rows[0].entry_hash) : null;
  }
  const row = sqliteDb()
    .prepare(
      `SELECT entry_hash FROM policy_audit WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get() as { entry_hash: string } | undefined;
  return row?.entry_hash ?? null;
}

export type PolicyAuditRow = {
  id: number;
  phone: string;
  action: string;
  verdict: string;
  reason: string | null;
  amount_usdc: number | null;
  payee: string | null;
  intent_json: string | null;
  prev_hash?: string | null;
  entry_hash?: string | null;
  created_at: string;
};

export type PendingClaim = {
  id: number;
  from_phone: string;
  to_phone: string;
  amount_usdc: number;
  status: string;
  hold_tx_hash: string | null;
  settle_tx_hash: string | null;
  expires_at: string;
  created_at: string;
};

function mapClaim(row: Record<string, unknown>): PendingClaim {
  return {
    id: Number(row.id),
    from_phone: String(row.from_phone),
    to_phone: String(row.to_phone),
    amount_usdc: Number(row.amount_usdc),
    status: String(row.status),
    hold_tx_hash: row.hold_tx_hash ? String(row.hold_tx_hash) : null,
    settle_tx_hash: row.settle_tx_hash ? String(row.settle_tx_hash) : null,
    expires_at: String(row.expires_at),
    created_at: String(row.created_at),
  };
}

export async function createPendingClaim(input: {
  from_phone: string;
  to_phone: string;
  amount_usdc: number;
  expires_at: string;
  hold_tx_hash?: string;
}): Promise<PendingClaim> {
  await initDb();
  const from = normalizePhone(input.from_phone);
  const to = normalizePhone(input.to_phone);
  if (usingPostgres) {
    const r = await pool!.query(
      `INSERT INTO pending_claims (from_phone, to_phone, amount_usdc, status, hold_tx_hash, expires_at)
       VALUES ($1, $2, $3, 'held', $4, $5) RETURNING *`,
      [from, to, input.amount_usdc, input.hold_tx_hash ?? null, input.expires_at],
    );
    return mapClaim(r.rows[0]);
  }
  const info = sqliteDb()
    .prepare(
      `INSERT INTO pending_claims (from_phone, to_phone, amount_usdc, status, hold_tx_hash, expires_at)
       VALUES (?, ?, ?, 'held', ?, ?)`,
    )
    .run(from, to, input.amount_usdc, input.hold_tx_hash ?? null, input.expires_at);
  const row = sqliteDb()
    .prepare(`SELECT * FROM pending_claims WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as Record<string, unknown>;
  return mapClaim(row);
}

export async function listHeldClaimsForPayee(toPhone: string): Promise<PendingClaim[]> {
  await initDb();
  const to = normalizePhone(toPhone);
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT * FROM pending_claims WHERE to_phone = $1 AND status = 'held' ORDER BY id ASC`,
      [to],
    );
    return r.rows.map((row) => mapClaim(row));
  }
  return (
    sqliteDb()
      .prepare(
        `SELECT * FROM pending_claims WHERE to_phone = ? AND status = 'held' ORDER BY id ASC`,
      )
      .all(to) as Record<string, unknown>[]
  ).map(mapClaim);
}

export async function listExpiredHeldClaims(nowIso: string): Promise<PendingClaim[]> {
  await initDb();
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT * FROM pending_claims WHERE status = 'held' AND expires_at <= $1 ORDER BY id ASC`,
      [nowIso],
    );
    return r.rows.map((row) => mapClaim(row));
  }
  return (
    sqliteDb()
      .prepare(
        `SELECT * FROM pending_claims WHERE status = 'held' AND expires_at <= ? ORDER BY id ASC`,
      )
      .all(nowIso) as Record<string, unknown>[]
  ).map(mapClaim);
}

export async function markPendingClaim(
  id: number,
  status: "claimed" | "expired" | "refunded",
  settleTxHash?: string,
): Promise<void> {
  await initDb();
  if (usingPostgres) {
    await pool!.query(
      `UPDATE pending_claims SET status = $1, settle_tx_hash = COALESCE($2, settle_tx_hash) WHERE id = $3`,
      [status, settleTxHash ?? null, id],
    );
  } else {
    sqliteDb()
      .prepare(
        `UPDATE pending_claims SET status = ?, settle_tx_hash = COALESCE(?, settle_tx_hash) WHERE id = ?`,
      )
      .run(status, settleTxHash ?? null, id);
  }
}

export async function sumPendingClaimsToday(fromPhone: string): Promise<number> {
  await initDb();
  const p = normalizePhone(fromPhone);
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT COUNT(*)::int AS n FROM pending_claims
       WHERE from_phone = $1 AND created_at::date = CURRENT_DATE`,
      [p],
    );
    return Number(r.rows[0]?.n ?? 0);
  }
  const row = sqliteDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM pending_claims
       WHERE from_phone = ? AND date(created_at) = date('now')`,
    )
    .get(p) as { n: number };
  return Number(row.n ?? 0);
}

export async function setRiskCooldown(phone: string, untilIso: string): Promise<User> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    await pool!.query(`UPDATE users SET risk_cooldown_until = $1 WHERE phone = $2`, [untilIso, p]);
  } else {
    sqliteDb().prepare(`UPDATE users SET risk_cooldown_until = ? WHERE phone = ?`).run(untilIso, p);
  }
  return (await getUser(p))!;
}

export async function setCallbackVerified(phone: string, untilIso: string): Promise<User> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    await pool!.query(`UPDATE users SET callback_verified_until = $1 WHERE phone = $2`, [
      untilIso,
      p,
    ]);
  } else {
    sqliteDb()
      .prepare(`UPDATE users SET callback_verified_until = ? WHERE phone = ?`)
      .run(untilIso, p);
  }
  return (await getUser(p))!;
}

export async function setRecoveryChallenge(
  phone: string,
  codeHash: string,
  expiresIso: string,
): Promise<void> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    await pool!.query(
      `UPDATE users SET recovery_code_hash = $1, recovery_expires_at = $2 WHERE phone = $3`,
      [codeHash, expiresIso, p],
    );
  } else {
    sqliteDb()
      .prepare(
        `UPDATE users SET recovery_code_hash = ?, recovery_expires_at = ? WHERE phone = ?`,
      )
      .run(codeHash, expiresIso, p);
  }
}

export async function clearRecoveryChallenge(phone: string): Promise<void> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    await pool!.query(
      `UPDATE users SET recovery_code_hash = NULL, recovery_expires_at = NULL WHERE phone = $1`,
      [p],
    );
  } else {
    sqliteDb()
      .prepare(`UPDATE users SET recovery_code_hash = NULL, recovery_expires_at = NULL WHERE phone = ?`)
      .run(p);
  }
}

/** Export policy decisions for compliance (newest first). */
export async function listPolicyAudit(opts?: {
  phone?: string;
  limit?: number;
  since?: string;
}): Promise<PolicyAuditRow[]> {
  await initDb();
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
  if (usingPostgres) {
    const params: unknown[] = [];
    let where = "";
    if (opts?.phone) {
      params.push(normalizePhone(opts.phone));
      where += ` WHERE phone = $${params.length}`;
    }
    if (opts?.since) {
      params.push(opts.since);
      where += where ? ` AND created_at >= $${params.length}` : ` WHERE created_at >= $${params.length}`;
    }
    params.push(limit);
    const r = await pool!.query(
      `SELECT id, phone, action, verdict, reason, amount_usdc, payee, intent_json, created_at
       FROM policy_audit${where} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows as PolicyAuditRow[];
  }

  if (opts?.phone && opts?.since) {
    return sqliteDb()
      .prepare(
        `SELECT id, phone, action, verdict, reason, amount_usdc, payee, intent_json, created_at
         FROM policy_audit WHERE phone = ? AND created_at >= ? ORDER BY id DESC LIMIT ?`,
      )
      .all(normalizePhone(opts.phone), opts.since, limit) as PolicyAuditRow[];
  }
  if (opts?.phone) {
    return sqliteDb()
      .prepare(
        `SELECT id, phone, action, verdict, reason, amount_usdc, payee, intent_json, created_at
         FROM policy_audit WHERE phone = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(normalizePhone(opts.phone), limit) as PolicyAuditRow[];
  }
  if (opts?.since) {
    return sqliteDb()
      .prepare(
        `SELECT id, phone, action, verdict, reason, amount_usdc, payee, intent_json, created_at
         FROM policy_audit WHERE created_at >= ? ORDER BY id DESC LIMIT ?`,
      )
      .all(opts.since, limit) as PolicyAuditRow[];
  }
  return sqliteDb()
    .prepare(
      `SELECT id, phone, action, verdict, reason, amount_usdc, payee, intent_json, created_at
       FROM policy_audit ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as PolicyAuditRow[];
}

export type UserRuleRow = {
  id: number;
  phone: string;
  rule_id: string;
  kind: string;
  max_usdc: number | null;
  label: string | null;
  spoken: string;
  readback: string;
  rules_hash: string | null;
  status: string;
  created_at: string;
};

export async function insertUserRule(row: {
  phone: string;
  rule_id: string;
  kind: string;
  max_usdc: number | null;
  label: string | null;
  spoken: string;
  readback: string;
  rules_hash: string | null;
}): Promise<void> {
  await initDb();
  const p = normalizePhone(row.phone);
  if (usingPostgres) {
    await pool!.query(
      `INSERT INTO user_policy_rules
       (phone, rule_id, kind, max_usdc, label, spoken, readback, rules_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')`,
      [
        p,
        row.rule_id,
        row.kind,
        row.max_usdc,
        row.label,
        row.spoken,
        row.readback,
        row.rules_hash,
      ],
    );
    return;
  }
  sqliteDb()
    .prepare(
      `INSERT INTO user_policy_rules
       (phone, rule_id, kind, max_usdc, label, spoken, readback, rules_hash, status)
       VALUES (?,?,?,?,?,?,?,?,'active')`,
    )
    .run(
      p,
      row.rule_id,
      row.kind,
      row.max_usdc,
      row.label,
      row.spoken,
      row.readback,
      row.rules_hash,
    );
}

export async function getActiveUserRules(phone: string): Promise<UserRuleRow[]> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT * FROM user_policy_rules WHERE phone = $1 AND status = 'active' ORDER BY id`,
      [p],
    );
    return r.rows as UserRuleRow[];
  }
  return sqliteDb()
    .prepare(`SELECT * FROM user_policy_rules WHERE phone = ? AND status = 'active' ORDER BY id`)
    .all(p) as UserRuleRow[];
}

export async function revokeUserRules(phone: string): Promise<void> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    await pool!.query(
      `UPDATE user_policy_rules SET status = 'revoked' WHERE phone = $1 AND status = 'active'`,
      [p],
    );
    return;
  }
  sqliteDb()
    .prepare(
      `UPDATE user_policy_rules SET status = 'revoked' WHERE phone = ? AND status = 'active'`,
    )
    .run(p);
}

export async function sumLedgerKindToCounterparty(
  phone: string,
  counterparty: string,
  kinds: string[],
): Promise<number> {
  await initDb();
  const p = normalizePhone(phone);
  if (!kinds.length) return 0;
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT COALESCE(SUM(amount_usdc),0)::float AS s FROM ledger
       WHERE phone = $1 AND counterparty = $2 AND kind = ANY($3::text[])`,
      [p, counterparty, kinds],
    );
    return Number(r.rows[0]?.s ?? 0);
  }
  const placeholders = kinds.map(() => "?").join(",");
  const row = sqliteDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_usdc),0) AS s FROM ledger
       WHERE phone = ? AND counterparty = ? AND kind IN (${placeholders})`,
    )
    .get(p, counterparty, ...kinds) as { s: number };
  return Number(row?.s ?? 0);
}

export type StandingOrder = {
  id: number;
  phone: string;
  amount_usdc: number;
  to_label: string;
  to_phone: string | null;
  to_address: string | null;
  cadence: string;
  next_run_at: string;
  status: string;
  last_idem: string | null;
  created_at: string;
};

export async function createStandingOrder(input: {
  phone: string;
  amount_usdc: number;
  to_label: string;
  to_phone?: string | null;
  to_address?: string | null;
  cadence: string;
  next_run_at: string;
}): Promise<StandingOrder> {
  await initDb();
  const p = normalizePhone(input.phone);
  if (usingPostgres) {
    const r = await pool!.query(
      `INSERT INTO standing_orders
       (phone, amount_usdc, to_label, to_phone, to_address, cadence, next_run_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING *`,
      [
        p,
        input.amount_usdc,
        input.to_label,
        input.to_phone ?? null,
        input.to_address ?? null,
        input.cadence,
        input.next_run_at,
      ],
    );
    return r.rows[0] as StandingOrder;
  }
  const info = sqliteDb()
    .prepare(
      `INSERT INTO standing_orders
       (phone, amount_usdc, to_label, to_phone, to_address, cadence, next_run_at, status)
       VALUES (?,?,?,?,?,?,?,'active')`,
    )
    .run(
      p,
      input.amount_usdc,
      input.to_label,
      input.to_phone ?? null,
      input.to_address ?? null,
      input.cadence,
      input.next_run_at,
    );
  return sqliteDb()
    .prepare(`SELECT * FROM standing_orders WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as StandingOrder;
}

export async function listDueStandingOrders(nowIso: string): Promise<StandingOrder[]> {
  await initDb();
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT * FROM standing_orders WHERE status = 'active' AND next_run_at <= $1 ORDER BY id LIMIT 50`,
      [nowIso],
    );
    return r.rows as StandingOrder[];
  }
  return sqliteDb()
    .prepare(
      `SELECT * FROM standing_orders WHERE status = 'active' AND next_run_at <= ? ORDER BY id LIMIT 50`,
    )
    .all(nowIso) as StandingOrder[];
}

export async function listStandingOrders(phone: string): Promise<StandingOrder[]> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT * FROM standing_orders WHERE phone = $1 AND status = 'active' ORDER BY id`,
      [p],
    );
    return r.rows as StandingOrder[];
  }
  return sqliteDb()
    .prepare(`SELECT * FROM standing_orders WHERE phone = ? AND status = 'active' ORDER BY id`)
    .all(p) as StandingOrder[];
}

export async function bumpStandingOrder(
  id: number,
  nextRunAt: string,
  lastIdem: string,
): Promise<void> {
  await initDb();
  if (usingPostgres) {
    await pool!.query(
      `UPDATE standing_orders SET next_run_at = $1, last_idem = $2 WHERE id = $3`,
      [nextRunAt, lastIdem, id],
    );
    return;
  }
  sqliteDb()
    .prepare(`UPDATE standing_orders SET next_run_at = ?, last_idem = ? WHERE id = ?`)
    .run(nextRunAt, lastIdem, id);
}

export async function cancelStandingOrder(phone: string, id: number): Promise<boolean> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    const r = await pool!.query(
      `UPDATE standing_orders SET status = 'cancelled' WHERE id = $1 AND phone = $2 AND status = 'active'`,
      [id, p],
    );
    return (r.rowCount ?? 0) > 0;
  }
  const info = sqliteDb()
    .prepare(
      `UPDATE standing_orders SET status = 'cancelled' WHERE id = ? AND phone = ? AND status = 'active'`,
    )
    .run(id, p);
  return info.changes > 0;
}

export type SavingsLock = {
  id: number;
  phone: string;
  amount_usdc: number;
  unlock_at: string;
  status: string;
  created_at: string;
};

export async function createSavingsLock(input: {
  phone: string;
  amount_usdc: number;
  unlock_at: string;
}): Promise<SavingsLock> {
  await initDb();
  const p = normalizePhone(input.phone);
  if (usingPostgres) {
    const r = await pool!.query(
      `INSERT INTO savings_locks (phone, amount_usdc, unlock_at, status)
       VALUES ($1,$2,$3,'active') RETURNING *`,
      [p, input.amount_usdc, input.unlock_at],
    );
    return r.rows[0] as SavingsLock;
  }
  const info = sqliteDb()
    .prepare(
      `INSERT INTO savings_locks (phone, amount_usdc, unlock_at, status) VALUES (?,?,?,'active')`,
    )
    .run(p, input.amount_usdc, input.unlock_at);
  return sqliteDb()
    .prepare(`SELECT * FROM savings_locks WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as SavingsLock;
}

export async function sumActiveSavingsLocked(phone: string, nowIso: string): Promise<number> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT COALESCE(SUM(amount_usdc),0)::float AS s FROM savings_locks
       WHERE phone = $1 AND status = 'active' AND unlock_at > $2`,
      [p, nowIso],
    );
    return Number(r.rows[0]?.s ?? 0);
  }
  const row = sqliteDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_usdc),0) AS s FROM savings_locks
       WHERE phone = ? AND status = 'active' AND unlock_at > ?`,
    )
    .get(p, nowIso) as { s: number };
  return Number(row?.s ?? 0);
}

export async function listSavingsLocks(phone: string): Promise<SavingsLock[]> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT * FROM savings_locks WHERE phone = $1 AND status = 'active' ORDER BY id`,
      [p],
    );
    return r.rows as SavingsLock[];
  }
  return sqliteDb()
    .prepare(`SELECT * FROM savings_locks WHERE phone = ? AND status = 'active' ORDER BY id`)
    .all(p) as SavingsLock[];
}

export async function releaseMaturedLocks(phone: string, nowIso: string): Promise<number> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    const r = await pool!.query(
      `UPDATE savings_locks SET status = 'released' WHERE phone = $1 AND status = 'active' AND unlock_at <= $2`,
      [p, nowIso],
    );
    return r.rowCount ?? 0;
  }
  const info = sqliteDb()
    .prepare(
      `UPDATE savings_locks SET status = 'released' WHERE phone = ? AND status = 'active' AND unlock_at <= ?`,
    )
    .run(p, nowIso);
  return info.changes;
}

/** Channel alias → canonical E.164 (Telegram chat id → phone). */
export async function resolveLinkedPhone(
  channel: string,
  externalId: string,
): Promise<string | null> {
  await initDb();
  const ch = channel.toLowerCase();
  const ext = String(externalId).replace(/[^\d-]/g, "");
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT phone FROM account_links WHERE channel = $1 AND external_id = $2`,
      [ch, ext],
    );
    return r.rows[0]?.phone ? String(r.rows[0].phone) : null;
  }
  const row = sqliteDb()
    .prepare(`SELECT phone FROM account_links WHERE channel = ? AND external_id = ?`)
    .get(ch, ext) as { phone?: string } | undefined;
  return row?.phone ?? null;
}

export async function listLinksForPhone(phone: string): Promise<
  Array<{ channel: string; external_id: string; phone: string; linked_at: string }>
> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    const r = await pool!.query(
      `SELECT channel, external_id, phone, linked_at FROM account_links WHERE phone = $1`,
      [p],
    );
    return r.rows as Array<{
      channel: string;
      external_id: string;
      phone: string;
      linked_at: string;
    }>;
  }
  return sqliteDb()
    .prepare(`SELECT channel, external_id, phone, linked_at FROM account_links WHERE phone = ?`)
    .all(p) as Array<{
    channel: string;
    external_id: string;
    phone: string;
    linked_at: string;
  }>;
}

/**
 * Bind channel external id → E.164. One chat per phone per channel (upsert).
 */
export async function linkChannelAccount(
  channel: string,
  externalId: string,
  phone: string,
): Promise<void> {
  await initDb();
  const ch = channel.toLowerCase();
  const ext = String(externalId).replace(/[^\d-]/g, "");
  const p = normalizePhone(phone);
  if (!ext) throw new Error("empty channel external id");
  if (!p.startsWith("+")) throw new Error("link target must be E.164 phone");

  if (usingPostgres) {
    // Drop prior link of this phone on same channel (another chat) and this chat's old phone.
    await pool!.query(`DELETE FROM account_links WHERE channel = $1 AND phone = $2`, [ch, p]);
    await pool!.query(
      `INSERT INTO account_links (channel, external_id, phone)
       VALUES ($1, $2, $3)
       ON CONFLICT (channel, external_id) DO UPDATE SET phone = EXCLUDED.phone, linked_at = NOW()`,
      [ch, ext, p],
    );
    return;
  }
  const db = sqliteDb();
  db.prepare(`DELETE FROM account_links WHERE channel = ? AND phone = ?`).run(ch, p);
  db.prepare(
    `INSERT INTO account_links (channel, external_id, phone) VALUES (?, ?, ?)
     ON CONFLICT (channel, external_id) DO UPDATE SET phone = excluded.phone, linked_at = datetime('now')`,
  ).run(ch, ext, p);
}

export async function countLedgerEntries(phone: string): Promise<number> {
  await initDb();
  const p = normalizePhone(phone);
  if (usingPostgres) {
    const r = await pool!.query(`SELECT COUNT(*)::int AS n FROM ledger WHERE phone = $1`, [p]);
    return Number(r.rows[0]?.n ?? 0);
  }
  const row = sqliteDb()
    .prepare(`SELECT COUNT(*) AS n FROM ledger WHERE phone = ?`)
    .get(p) as { n: number };
  return Number(row.n);
}

/** Drop an empty provisional tg: user row (sessions + user). Refuses if ledger or HotlineNS. */
export async function deleteProvisionalTelegramUser(tgAccount: string): Promise<boolean> {
  await initDb();
  const p = normalizePhone(tgAccount);
  if (!p.startsWith("tg:")) return false;
  const user = await getUser(p);
  if (!user) return false;
  if (user.hotline_name) return false;
  if ((await countLedgerEntries(p)) > 0) return false;

  if (usingPostgres) {
    await pool!.query(`DELETE FROM sessions WHERE phone = $1`, [p]);
    await pool!.query(`DELETE FROM contacts WHERE phone = $1`, [p]);
    await pool!.query(`DELETE FROM users WHERE phone = $1`, [p]);
    return true;
  }
  const db = sqliteDb();
  db.prepare(`DELETE FROM sessions WHERE phone = ?`).run(p);
  db.prepare(`DELETE FROM contacts WHERE phone = ?`).run(p);
  db.prepare(`DELETE FROM users WHERE phone = ?`).run(p);
  return true;
}
