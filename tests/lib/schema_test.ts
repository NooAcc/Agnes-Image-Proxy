import { assertEquals, assertRejects } from "@std/assert";
import { ensureSchema, resetSchema } from "../../lib/accounts.ts";
import { SCHEMA_VERSION } from "../../lib/limits.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";

Deno.test("a fresh database records the schema version", async () => {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  const row = (await sql.execute(
    "SELECT value FROM schema_meta WHERE key = 'version'",
  )).rows[0];
  assertEquals(row.value, String(SCHEMA_VERSION));
  sql.close();
});

Deno.test("a version mismatch fails instead of altering tables", async () => {
  const sql = createNodeSqliteExecutor();
  await sql.execute("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  await sql.execute("INSERT INTO schema_meta (key, value) VALUES ('version', '1')");
  await assertRejects(() => ensureSchema(sql), Error, "schema version mismatch");
  sql.close();
});

Deno.test("a non-empty database without a version fails", async () => {
  const sql = createNodeSqliteExecutor();
  await sql.execute("CREATE TABLE accounts (id INTEGER PRIMARY KEY)");
  await assertRejects(() => ensureSchema(sql), Error, "schema version missing");
  sql.close();
});

Deno.test("concurrent schema initialization is idempotent", async () => {
  const sql = createNodeSqliteExecutor();
  await Promise.all([ensureSchema(sql), ensureSchema(sql)]);
  const row = (await sql.execute(
    "SELECT value FROM schema_meta WHERE key = 'version'",
  )).rows[0];
  assertEquals(row.value, String(SCHEMA_VERSION));
  sql.close();
});

Deno.test("resetSchema recreates the current schema", async () => {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  await resetSchema(sql);
  const row = (await sql.execute(
    "SELECT value FROM schema_meta WHERE key = 'version'",
  )).rows[0];
  assertEquals(row.value, String(SCHEMA_VERSION));
  sql.close();
});
