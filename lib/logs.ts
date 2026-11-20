import { executeBatch, type SqlArg, type SqlExecutor } from "./sql.ts";
import { LOG_LIST_LIMIT, REQUEST_LOG_LIMIT } from "./limits.ts";

export interface RequestLogInput {
  ts: string;
  endpoint: string;
  path: string;
  model: string;
  accountId: number | null;
  accountName: string | null;
  status: number;
  ok: boolean;
  durationMs: number;
  requested: number;
  images: number;
  failed: number;
  size: string | null;
  error: string | null;
  attempts: unknown;
}

export interface RequestLogRow {
  id: number;
  ts: string;
  endpoint: string;
  path: string | null;
  model: string;
  accountId: number | null;
  accountName: string | null;
  status: number;
  ok: boolean;
  durationMs: number;
  requested: number;
  images: number;
  failed: number;
  size: string | null;
  error: string | null;
  attempts: unknown;
}

export interface RequestLogStore {
  record(input: RequestLogInput): Promise<void>;
  list(limit?: number): Promise<RequestLogRow[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

function toRow(row: Record<string, unknown>): RequestLogRow {
  let attempts: unknown = null;
  if (typeof row.attempts === "string" && row.attempts !== "") {
    try {
      attempts = JSON.parse(row.attempts);
    } catch {
      attempts = row.attempts;
    }
  }
  return {
    id: Number(row.id),
    ts: String(row.ts),
    endpoint: String(row.endpoint),
    path: row.path === null ? null : String(row.path),
    model: String(row.model),
    accountId: row.account_id === null ? null : Number(row.account_id),
    accountName: row.account_name === null ? null : String(row.account_name),
    status: Number(row.status),
    ok: Number(row.ok) === 1,
    durationMs: Number(row.duration_ms),
    requested: Number(row.requested),
    images: Number(row.images),
    failed: Number(row.failed),
    size: row.size === null ? null : String(row.size),
    error: row.error === null ? null : String(row.error),
    attempts,
  };
}

export function createRequestLogStore(sql: SqlExecutor): RequestLogStore {
  return {
    async record(input) {
      const args: SqlArg[] = [
        input.ts,
        input.endpoint,
        input.path,
        input.model,
        input.accountId,
        input.accountName,
        input.status,
        input.ok ? 1 : 0,
        input.durationMs,
        input.requested,
        input.images,
        input.failed,
        input.size,
        input.error,
        JSON.stringify(input.attempts ?? []),
      ];
      await executeBatch(sql, [
        {
          sql: `INSERT INTO request_log
            (ts, endpoint, path, model, account_id, account_name, status, ok, duration_ms,
             requested, images, failed, size, error, attempts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args,
        },
        {
          sql: `DELETE FROM request_log
            WHERE id NOT IN (SELECT id FROM request_log ORDER BY id DESC LIMIT ?)`,
          args: [REQUEST_LOG_LIMIT],
        },
      ]);
    },

    async list(limit = LOG_LIST_LIMIT) {
      const result = await sql.execute(
        "SELECT * FROM request_log ORDER BY id DESC LIMIT ?",
        [limit],
      );
      return result.rows.map(toRow);
    },

    async count() {
      const result = await sql.execute("SELECT COUNT(*) AS c FROM request_log");
      return Number(result.rows[0]?.c ?? 0);
    },

    async clear() {
      await sql.execute("DELETE FROM request_log");
    },
  };
}
