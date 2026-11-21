import { assertEquals, assertRejects } from "@std/assert";
import { LibsqlError } from "@libsql/client/web";
import { ApiError } from "../../lib/errors.ts";
import {
  bytesFromRow,
  mapDatabaseError,
  normalizeDatabaseUrl,
  withTimeout,
} from "../../lib/sql.ts";
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

Deno.test("withTimeout rejects a hung query with a 503", async () => {
  const error = await assertRejects(() => withTimeout(new Promise(() => {}), 10));
  assertEquals(error instanceof ApiError && error.status, 503);
  assertEquals(error instanceof ApiError && error.code, "database_timeout");
});

Deno.test("a network LibsqlError maps to 503", () => {
  const mapped = mapDatabaseError(new LibsqlError("down", "NETWORK_ERROR"));
  assertEquals(mapped instanceof ApiError && mapped.status, 503);
  assertEquals(mapped instanceof ApiError && mapped.code, "database_unavailable");
});

Deno.test("a SQL error is rethrown", () => {
  const original = new LibsqlError("syntax", "SQLITE_ERROR");
  assertEquals(mapDatabaseError(original), original);
});
