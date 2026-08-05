/**
 * Dual store: SQLite (local/tests) or Postgres (Docker / staging).
 * Set DATABASE_URL=postgres://... for Postgres; else DATABASE_PATH for SQLite.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import pg from "pg";

export type User = {
  phone: string;
  name: string | null;
  pin_hash: string | null;
  wallet_address: string;
  wallet_ref: string;
  pin_fail_count: number;
  pin_locked_until: string | null;
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
`);
  // Soft migrations for older DBs
  const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("pin_fail_count")) {
    db.exec("ALTER TABLE users ADD COLUMN pin_fail_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("pin_locked_until")) {
    db.exec("ALTER TABLE users ADD COLUMN pin_locked_until TEXT");
  }
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
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  return digits.startsWith("00") ? `+${digits.slice(2)}` : `+${digits}`;
}

function mapUser(row: Record<string, unknown> | undefined): User | undefined {
  if (!row) return undefined;
  return {
    phone: String(row.phone),
    name: (row.name as string) ?? null,
    pin_hash: (row.pin_hash as string) ?? null,
    wallet_address: String(row.wallet_address),
    wallet_ref: String(row.wallet_ref),
    pin_fail_count: Number(row.pin_fail_count ?? 0),
    pin_locked_until: row.pin_locked_until ? String(row.pin_locked_until) : null,
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
       ON CONFLICT (id_key) DO NOTHING`,
      [idKey, p, json],
    );
  } else {
    sqliteDb()
      .prepare(
        `INSERT OR IGNORE INTO idempotency (id_key, phone, result_json) VALUES (?, ?, ?)`,
      )
      .run(idKey, p, json);
  }
}

/** Append-only policy gate decision (compliance artefact). */
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
  if (usingPostgres) {
    await pool!.query(
      `INSERT INTO policy_audit (phone, action, verdict, reason, amount_usdc, payee, intent_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        p,
        entry.action,
        entry.verdict,
        entry.reason ?? null,
        entry.amount_usdc ?? null,
        entry.payee ?? null,
        intentJson,
      ],
    );
  } else {
    sqliteDb()
      .prepare(
        `INSERT INTO policy_audit (phone, action, verdict, reason, amount_usdc, payee, intent_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p,
        entry.action,
        entry.verdict,
        entry.reason ?? null,
        entry.amount_usdc ?? null,
        entry.payee ?? null,
        intentJson,
      );
  }
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
  created_at: string;
};

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
