import { createClient } from "@libsql/client/web";

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

export function createSqlExecutor(
  options: { url: string; authToken?: string },
): SqlExecutor {
  const client = createClient({
    url: normalizeDatabaseUrl(options.url),
    authToken: options.authToken,
  });

  return {
    async execute(sql, args = []) {
      const result = await client.execute({ sql, args });
      return { rows: toRows(result.rows), rowsAffected: result.rowsAffected };
    },
    async batch(statements) {
      const results = await client.batch(
        statements.map((statement) => ({ sql: statement.sql, args: statement.args ?? [] })),
        "write",
      );
      return results.map((result) => ({
        rows: toRows(result.rows),
        rowsAffected: result.rowsAffected,
      }));
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
