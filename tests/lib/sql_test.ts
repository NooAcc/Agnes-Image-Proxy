import { assertEquals } from "@std/assert";
import { bytesFromRow, normalizeDatabaseUrl } from "../../lib/sql.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";

Deno.test("node sqlite executor round-trips a BLOB", async () => {
  const sql = createNodeSqliteExecutor();
  await sql.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, b BLOB)");
  const bytes = new Uint8Array([0, 1, 2, 255]);
  await sql.execute("INSERT INTO t (b) VALUES (?)", [bytes]);
  const row = (await sql.execute("SELECT b FROM t")).rows[0];
  assertEquals(bytesFromRow(row.b), bytes);
  sql.close();
});

Deno.test("normalizeDatabaseUrl maps libsql to https", () => {
  assertEquals(normalizeDatabaseUrl("libsql://example.turso.io"), "https://example.turso.io");
});
