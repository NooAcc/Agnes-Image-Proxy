import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqlArg, SqlExecutor, SqlResult, SqlStatement } from "../sql.ts";

function statementReturnsRows(sql: string): boolean {
  return /^\s*(?:select|pragma|with)\b/i.test(sql) || /\breturning\b/i.test(sql);
}

function toPlainRows(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((row) => ({ ...(row as Record<string, unknown>) }));
}

/**
 * Test-only SqlExecutor backed by node:sqlite. Never imported by main.ts —
 * kept under lib/testing/ so the production dependency graph stays clean.
 */
export function createNodeSqliteExecutor(): SqlExecutor & { close(): void } {
  const db = new DatabaseSync(":memory:");

  const run = (sql: string, args: SqlArg[]): SqlResult => {
    const statement: StatementSync = db.prepare(sql);
    if (statementReturnsRows(sql)) {
      return { rows: toPlainRows(statement.all(...args)), rowsAffected: 0 };
    }
    const info = statement.run(...args);
    return { rows: [], rowsAffected: Number(info.changes ?? 0) };
  };

  return {
    execute(sql: string, args: SqlArg[] = []): Promise<SqlResult> {
      return Promise.resolve(run(sql, args));
    },
    batch(statements: SqlStatement[]): Promise<SqlResult[]> {
      const out: SqlResult[] = [];
      for (const statement of statements) out.push(run(statement.sql, statement.args ?? []));
      return Promise.resolve(out);
    },
    close() {
      db.close();
    },
  };
}
