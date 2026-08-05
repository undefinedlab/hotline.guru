/**
 * Dual store: SQLite (local/tests) or Postgres (Docker / staging).
 * Set DATABASE_URL=postgres://... for Postgres; else DATABASE_PATH for SQLite.
 */
import fs from "node:fs";
import path from "node:path";
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
`);
  ensureUserColumnsSqlite(db);
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
`);
  await client.query(`
ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_tier INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS national_id_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sim_attest_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE users ADD COLUMN IF NOT EXISTS sim_attest_provider TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sim_attest_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hotline_name TEXT;
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
