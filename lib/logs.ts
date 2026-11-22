import { executeBatch, type SqlArg, type SqlExecutor } from "./sql.ts";
import { LOG_LIST_LIMIT, REQUEST_LOG_LIMIT } from "./limits.ts";

export type LogStage = "parse" | "dispatch" | "complete";

/** `request` covers client image requests; `enrich` covers image-info jobs (thumbnails/NSFW). */
export type LogCategory = "request" | "enrich";

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
  category: LogCategory;
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
  attempts: SubRequestTrace[];
}

export interface RequestLogRow {
  id: number;
  requestId: string;
  ts: string;
  category: LogCategory;
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
    category: row.category === "enrich" ? "enrich" : "request",
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
        input.category,
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
            (request_id, ts, category, stage, endpoint, path, model, account_id, account_name,
             status, ok, duration_ms, requested, images, failed, size_request, size_actual,
             error_code, error, attempts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

export interface EnrichmentLogInput {
  ts: string;
  /** Log endpoint name, e.g. `gallery/enrich` (backfill) or `archive/enrich` (post-generation). */
  endpoint: string;
  path: string | null;
  requested: number;
  succeeded: number;
  failed: number;
  durationMs: number;
}

/**
 * Records one image-info job (thumbnail + NSFW enrichment) as an `enrich` category log.
 * No-op jobs are skipped so idle backfill clicks do not flood the log.
 */
export async function recordEnrichmentLog(
  logs: RequestLogStore,
  input: EnrichmentLogInput,
): Promise<void> {
  if (input.requested === 0) return;
  const failed = Math.max(0, input.failed);
  const succeeded = Math.max(0, input.succeeded);
  const ok = failed === 0;
  const status = ok || succeeded > 0 ? 200 : 502;
  try {
    await logs.record({
      requestId: crypto.randomUUID(),
      ts: input.ts,
      category: "enrich",
      stage: "complete",
      endpoint: input.endpoint,
      path: input.path,
      model: null,
      accountId: null,
      accountName: null,
      status,
      ok,
      durationMs: input.durationMs,
      requested: input.requested,
      images: succeeded,
      failed,
      sizeRequest: null,
      sizeActual: null,
      errorCode: ok ? null : (succeeded > 0 ? "partial_success" : "enrich_failed"),
      error: ok ? null : `${failed} of ${input.requested} images failed enrichment`,
      attempts: [],
    });
  } catch (error) {
    console.error("enrichment log write failed:", error);
  }
}
