import { ApiError } from "./errors.ts";
import { SCHEMA_VERSION } from "./limits.ts";
import { executeBatch, type SqlArg, type SqlExecutor } from "./sql.ts";

const BUSINESS_TABLES = [
  "accounts",
  "request_log",
  "model_usage_daily",
  "gallery",
  "settings",
  "auth_state",
];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL UNIQUE,
    api_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'healthy',
    cooldown_until TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    use_seq INTEGER NOT NULL DEFAULT 0,
    upstream_requests INTEGER NOT NULL DEFAULT 0,
    upstream_images INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    stage TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    path TEXT,
    model TEXT,
    account_id INTEGER,
    account_name TEXT,
    status INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    requested INTEGER,
    images INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    size_request TEXT,
    size_actual TEXT,
    error_code TEXT,
    error TEXT,
    attempts TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS model_usage_daily (
    model TEXT NOT NULL,
    day TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    successes INTEGER NOT NULL DEFAULT 0,
    partials INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    images INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT NOT NULL,
    PRIMARY KEY (model, day)
  )`,
  `CREATE TABLE IF NOT EXISTS gallery (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    model TEXT NOT NULL,
    account_id INTEGER,
    account_name TEXT,
    prompt TEXT NOT NULL,
    size TEXT,
    tier TEXT,
    ratio TEXT,
    mime TEXT NOT NULL,
    bytes BLOB,
    byte_size INTEGER NOT NULL DEFAULT 0,
    source_url TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    thumb BLOB,
    thumb_mime TEXT,
    nsfw TEXT,
    tag TEXT,
    enrich_status TEXT,
    enrich_error TEXT,
    enriched_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS gallery_tag_id ON gallery (tag, id DESC)`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

function versionMismatchMessage(found: string): string {
  const hint = found === "2" && SCHEMA_VERSION === 3
    ? "v2→v3 can be upgraded in place: run the SQL in README (schema v3 upgrade) before deploying; reset-db deletes all data"
    : "run deno task reset-db";
  return `schema version mismatch: found ${found}, expected ${SCHEMA_VERSION}; ${hint}`;
}

export async function ensureSchema(sql: SqlExecutor): Promise<void> {
  await sql.execute(
    "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );

  const versionRows = (await sql.execute(
    "SELECT value FROM schema_meta WHERE key = 'version'",
  )).rows;
  if (versionRows.length > 0) {
    const found = String(versionRows[0].value);
    if (found !== String(SCHEMA_VERSION)) {
      throw new Error(versionMismatchMessage(found));
    }
  } else {
    const existing = await sql.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${
        BUSINESS_TABLES.map(() => "?").join(", ")
      })`,
      BUSINESS_TABLES,
    );
    if (existing.rows.length > 0) {
      throw new Error(
        "schema version missing on a non-empty database; run deno task reset-db",
      );
    }
    await sql.execute(
      "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('version', ?)",
      [String(SCHEMA_VERSION)],
    );
    const confirmed = (await sql.execute(
      "SELECT value FROM schema_meta WHERE key = 'version'",
    )).rows[0];
    const stored = String(confirmed?.value ?? "");
    if (stored !== String(SCHEMA_VERSION)) {
      throw new Error(versionMismatchMessage(stored));
    }
  }

  await executeBatch(sql, SCHEMA.map((statement) => ({ sql: statement })));
  await sql.execute(
    `INSERT OR IGNORE INTO auth_state (key, value, updated_at)
     VALUES ('session_epoch', '1', ?)`,
    [new Date().toISOString()],
  );
}

/** Drops every business table and recreates the current schema. */
export async function resetSchema(sql: SqlExecutor): Promise<void> {
  const tables = [...BUSINESS_TABLES, "schema_meta"];
  await executeBatch(
    sql,
    tables.map((table) => ({ sql: `DROP TABLE IF EXISTS ${table}` })),
  );
  await ensureSchema(sql);
}

export interface AccountRecord {
  id: number;
  name: string;
  apiKey: string;
  enabled: boolean;
  status: string;
  cooldownUntil: string | null;
  failCount: number;
  lastUsedAt: string | null;
  upstreamRequests: number;
  upstreamImages: number;
  createdAt: string;
}

export interface AccountSummary extends Omit<AccountRecord, "apiKey"> {
  apiKeyMasked: string;
}

export interface ClaimedAccount {
  id: number;
  name: string;
  apiKey: string;
  seq: number;
  consecutiveFailures: number;
}

export interface AccountStore {
  list(): Promise<AccountSummary[]>;
  get(id: number): Promise<AccountRecord | null>;
  create(input: { name: string; apiKey: string }): Promise<AccountRecord>;
  update(id: number, patch: { name?: string; enabled?: boolean; apiKey?: string }): Promise<
    AccountRecord
  >;
  remove(id: number): Promise<boolean>;
  claim(excludeIds?: number[]): Promise<ClaimedAccount | null>;
  resetHealth(id: number): Promise<boolean>;
  markHealthy(id: number, expectedFailCount: number): Promise<void>;
  recordSuccess(id: number, expectedFailCount: number): Promise<void>;
  recordUpstreamSuccess(id: number, images: number): Promise<void>;
  recordFailure(id: number, cooldownMs: number): Promise<void>;
}

export function maskKey(key: string): string {
  if (key.length === 0) throw new Error("empty API key");
  if (key.length < 9) return "…";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function toRecord(row: Record<string, unknown>): AccountRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    apiKey: String(row.api_key),
    enabled: Number(row.enabled) === 1,
    status: String(row.status),
    cooldownUntil: row.cooldown_until === null ? null : String(row.cooldown_until),
    failCount: Number(row.fail_count),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
    upstreamRequests: Number(row.upstream_requests),
    upstreamImages: Number(row.upstream_images),
    createdAt: String(row.created_at),
  };
}

function toSummary(record: AccountRecord): AccountSummary {
  const { apiKey, ...rest } = record;
  return { ...rest, apiKeyMasked: maskKey(apiKey) };
}

function conflict(name: string): ApiError {
  return new ApiError(
    409,
    `account name already exists: ${name}`,
    "invalid_request_error",
    "name",
    "name_conflict",
  );
}

export function createAccountStore(sql: SqlExecutor): AccountStore {
  const get = async (id: number): Promise<AccountRecord | null> => {
    const result = await sql.execute("SELECT * FROM accounts WHERE id = ?", [id]);
    return result.rows.length === 0 ? null : toRecord(result.rows[0]);
  };

  return {
    async list() {
      const result = await sql.execute("SELECT * FROM accounts ORDER BY seq, id");
      return result.rows.map((row) => toSummary(toRecord(row)));
    },

    get,

    async create(input) {
      const name = input.name.trim();
      const apiKey = input.apiKey.trim();
      if (name === "") {
        throw new ApiError(400, "account name is required", "invalid_request_error", "name");
      }
      if (apiKey === "") {
        throw new ApiError(400, "account apiKey is required", "invalid_request_error", "apiKey");
      }
      const existing = await sql.execute("SELECT id FROM accounts WHERE name = ?", [name]);
      if (existing.rows.length > 0) throw conflict(name);

      const inserted = await sql.execute(
        `INSERT INTO accounts
          (seq, name, api_key, enabled, status, fail_count, upstream_requests, upstream_images,
           created_at)
         VALUES
          ((SELECT COALESCE(MAX(seq), 0) + 1 FROM accounts), ?, ?, 1, 'healthy', 0, 0, 0, ?)
         RETURNING id`,
        [name, apiKey, new Date().toISOString()],
      );
      const created = await get(Number(inserted.rows[0].id));
      if (!created) throw new Error("failed to load the created account");
      return created;
    },

    async update(id, patch) {
      const sets: string[] = [];
      const args: SqlArg[] = [];
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (name === "") {
          throw new ApiError(400, "account name is required", "invalid_request_error", "name");
        }
        const existing = await sql.execute(
          "SELECT id FROM accounts WHERE name = ? AND id <> ?",
          [name, id],
        );
        if (existing.rows.length > 0) throw conflict(name);
        sets.push("name = ?");
        args.push(name);
      }
      if (patch.enabled !== undefined) {
        sets.push("enabled = ?");
        args.push(patch.enabled ? 1 : 0);
      }
      if (patch.apiKey !== undefined) {
        const apiKey = patch.apiKey.trim();
        if (apiKey === "") {
          throw new ApiError(400, "account apiKey is required", "invalid_request_error", "apiKey");
        }
        sets.push("api_key = ?", "status = 'healthy'", "fail_count = 0", "cooldown_until = NULL");
        args.push(apiKey);
      }
      if (sets.length > 0) {
        args.push(id);
        const result = await sql.execute(
          `UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`,
          args,
        );
        if (result.rowsAffected === 0) {
          throw new ApiError(404, "account not found", "invalid_request_error", "id");
        }
      }
      const updated = await get(id);
      if (!updated) throw new ApiError(404, "account not found", "invalid_request_error", "id");
      return updated;
    },

    async remove(id) {
      const result = await sql.execute("DELETE FROM accounts WHERE id = ?", [id]);
      return result.rowsAffected > 0;
    },

    async claim(excludeIds = []) {
      const now = new Date().toISOString();
      const exclusion = excludeIds.length > 0
        ? `AND id NOT IN (${excludeIds.map(() => "?").join(",")})`
        : "";
      const result = await sql.execute(
        `UPDATE accounts
         SET last_used_at = ?,
             use_seq = (SELECT COALESCE(MAX(use_seq), 0) + 1 FROM accounts)
         WHERE id = (
           SELECT id FROM accounts
           WHERE enabled = 1
             AND (cooldown_until IS NULL OR cooldown_until <= ?)
             ${exclusion}
           ORDER BY use_seq, seq, id
           LIMIT 1
         )
         RETURNING id, name, api_key, seq, fail_count`,
        [now, now, ...excludeIds],
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        id: Number(row.id),
        name: String(row.name),
        apiKey: String(row.api_key),
        seq: Number(row.seq),
        consecutiveFailures: Number(row.fail_count),
      };
    },

    async resetHealth(id) {
      const result = await sql.execute(
        "UPDATE accounts SET status = 'healthy', fail_count = 0, cooldown_until = NULL WHERE id = ?",
        [id],
      );
      return result.rowsAffected > 0;
    },

    async markHealthy(id, expectedFailCount) {
      await sql.execute(
        `UPDATE accounts SET status = 'healthy', fail_count = 0, cooldown_until = NULL
          WHERE id = ? AND fail_count = ?`,
        [id, expectedFailCount],
      );
    },

    async recordSuccess(id, expectedFailCount) {
      await sql.execute(
        `UPDATE accounts SET status = 'healthy', fail_count = 0, cooldown_until = NULL
          WHERE id = ? AND fail_count = ?`,
        [id, expectedFailCount],
      );
    },

    async recordUpstreamSuccess(id, images) {
      await sql.execute(
        `UPDATE accounts
            SET upstream_requests = upstream_requests + 1,
                upstream_images = upstream_images + ?
          WHERE id = ?`,
        [images, id],
      );
    },

    async recordFailure(id, cooldownMs) {
      const until = new Date(Date.now() + cooldownMs).toISOString();
      await sql.execute(
        "UPDATE accounts SET fail_count = fail_count + 1, status = 'degraded', cooldown_until = ? WHERE id = ?",
        [until, id],
      );
    },
  };
}
