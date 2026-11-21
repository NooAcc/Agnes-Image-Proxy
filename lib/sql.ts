import { createClient, LibsqlError } from "@libsql/client/web";
import { ApiError } from "./errors.ts";
import { DB_TIMEOUT_MS } from "./limits.ts";

/** A value that can be bound to a SQL placeholder. */
export type SqlArg = string | number | null | Uint8Array;

export interface SqlStatement {
  sql: string;
  args?: SqlArg[];
}

export interface SqlResult {
  rows: Record<string, unknown>[];
  rowsAffected: number;
}

/**
 * Minimal database port. Production uses the Turso/libSQL HTTP client;
 * tests use node:sqlite so the same SQL runs on a real engine.
 */
export interface SqlExecutor {
  execute(sql: string, args?: SqlArg[]): Promise<SqlResult>;
  batch?(statements: SqlStatement[]): Promise<SqlResult[]>;
}

/** libSQL URLs are not accepted by the fetch-based client in Deno. */
export function normalizeDatabaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("libsql://")) return `https://${trimmed.slice("libsql://".length)}`;
  return trimmed;
}

/** Normalizes BLOB-typed result cells across drivers. */
export function bytesFromRow(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return new Uint8Array(value as number[]);
  }
  return null;
}

function toRows(raw: readonly unknown[]): Record<string, unknown>[] {
  return raw.map((row) => ({ ...(row as Record<string, unknown>) }));
}

function isTimeoutError(error: unknown): boolean {
  const name = typeof error === "object" && error !== null
    ? (error as { name?: string }).name
    : undefined;
  if (name === "AbortError" || name === "TimeoutError") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("timeout") || message.includes("timed out");
}

const UNAVAILABLE_CODES = new Set([
  "NETWORK_ERROR",
  "HTTP_ERROR",
  "SERVER_ERROR",
  "PROTOCOL_ERROR",
  "RESPONSE_ERROR",
]);

/** Maps database transport failures onto 503s; SQL errors pass through. */
export function mapDatabaseError(error: unknown): unknown {
  if (isTimeoutError(error)) {
    return new ApiError(
      503,
      "database request timed out",
      "server_error",
      null,
      "database_timeout",
    );
  }
  if (error instanceof LibsqlError && UNAVAILABLE_CODES.has(error.code)) {
    return new ApiError(503, "database unavailable", "server_error", null, "database_unavailable");
  }
  return error;
}

/** Rejects with a 503 when a database task exceeds the timeout. */
export function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ApiError(
          503,
          "database request timed out",
          "server_error",
          null,
          "database_timeout",
        ),
      );
    }, timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createSqlExecutor(
  options: {
    url: string;
    authToken?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  },
): SqlExecutor {
  const timeoutMs = options.timeoutMs ?? DB_TIMEOUT_MS;
  const baseFetch = options.fetchImpl ?? fetch;
  const guardedFetch: typeof fetch = (input, init) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    return baseFetch(input, { ...init, signal });
  };
  const client = createClient({
    url: normalizeDatabaseUrl(options.url),
    authToken: options.authToken,
    fetch: guardedFetch,
  });

  return {
    async execute(sql, args = []) {
      try {
        const result = await withTimeout(client.execute({ sql, args }), timeoutMs);
        return { rows: toRows(result.rows), rowsAffected: result.rowsAffected };
      } catch (error) {
        throw mapDatabaseError(error);
      }
    },
    async batch(statements) {
      try {
        const results = await withTimeout(
          client.batch(
            statements.map((statement) => ({ sql: statement.sql, args: statement.args ?? [] })),
            "write",
          ),
          timeoutMs,
        );
        return results.map((result) => ({
          rows: toRows(result.rows),
          rowsAffected: result.rowsAffected,
        }));
      } catch (error) {
        throw mapDatabaseError(error);
      }
    },
  };
}

/** Runs a list of statements in one round trip when the driver supports it. */
export async function executeBatch(
  sql: SqlExecutor,
  statements: SqlStatement[],
): Promise<SqlResult[]> {
  if (sql.batch) return await sql.batch(statements);
  const results: SqlResult[] = [];
  for (const statement of statements) {
    results.push(await sql.execute(statement.sql, statement.args));
  }
  return results;
}
