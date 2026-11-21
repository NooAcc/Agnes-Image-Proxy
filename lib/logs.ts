import { executeBatch, type SqlArg, type SqlExecutor } from "./sql.ts";
import { LOG_LIST_LIMIT, REQUEST_LOG_LIMIT } from "./limits.ts";

export type LogStage = "parse" | "dispatch" | "complete";

export interface AttemptTrace {
  accountId: number | null;
  accountName: string | null;
  status: number;
  code: string | null;
  durationMs: number;
  message: string | null;
}

export interface SubRequestTrace {
  index: number;
  traces: AttemptTrace[];
}

export interface RequestLogInput {
  requestId: string;
  ts: string;
  stage: LogStage;
  endpoint: string;
  path: string;
  model: string | null;
  accountId: number | null;
  accountName: string | null;
  status: number;
  ok: boolean;
  durationMs: number;
  requested: number | null;
  images: number;
  failed: number;
  sizeRequest: string | null;
  sizeActual: string | null;
  errorCode: string | null;
  error: string | null;
  attempts: SubRequestTrace[];
}

export interface RequestLogRow {
  id: number;
  requestId: string;
  ts: string;
  stage: LogStage;
  endpoint: string;
  path: string | null;
  model: string | null;
  accountId: number | null;
  accountName: string | null;
  status: number;
  ok: boolean;
  durationMs: number;
  requested: number | null;
  images: number;
  failed: number;
  sizeRequest: string | null;
  sizeActual: string | null;
  errorCode: string | null;
  error: string | null;
  attempts: SubRequestTrace[] | null;
}

export interface RequestLogStore {
  record(input: RequestLogInput): Promise<void>;
  list(limit?: number): Promise<RequestLogRow[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

function optionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function optionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseAttempts(value: unknown): SubRequestTrace[] | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    return JSON.parse(value) as SubRequestTrace[];
  } catch {
    return null;
  }
}

function toRow(row: Record<string, unknown>): RequestLogRow {
  return {
    id: Number(row.id),
    requestId: String(row.request_id),
    ts: String(row.ts),
    stage: String(row.stage) as LogStage,
    endpoint: String(row.endpoint),
    path: optionalString(row.path),
    model: optionalString(row.model),
    accountId: optionalNumber(row.account_id),
    accountName: optionalString(row.account_name),
    status: Number(row.status),
    ok: Number(row.ok) === 1,
    durationMs: Number(row.duration_ms),
    requested: optionalNumber(row.requested),
    images: Number(row.images),
    failed: Number(row.failed),
    sizeRequest: optionalString(row.size_request),
    sizeActual: optionalString(row.size_actual),
    errorCode: optionalString(row.error_code),
    error: optionalString(row.error),
    attempts: parseAttempts(row.attempts),
  };
}

export function createRequestLogStore(sql: SqlExecutor): RequestLogStore {
  return {
    async record(input) {
      const args: SqlArg[] = [
        input.requestId,
        input.ts,
        input.stage,
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
        input.sizeRequest,
        input.sizeActual,
        input.errorCode,
        input.error,
        JSON.stringify(input.attempts ?? []),
      ];
      await executeBatch(sql, [
        {
          sql: `INSERT INTO request_log
            (request_id, ts, stage, endpoint, path, model, account_id, account_name, status, ok,
             duration_ms, requested, images, failed, size_request, size_actual, error_code, error,
             attempts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
