import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ApiError } from "../../lib/errors.ts";
import { createAccountStore, ensureSchema, maskKey } from "../../lib/accounts.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";

async function setup() {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  return { sql, store: createAccountStore(sql) };
}

Deno.test("ensureSchema creates every table", async () => {
  const { sql } = await setup();
  const tables = (await sql.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows
    .map((row) => String(row.name));
  for (const table of ["accounts", "request_log", "model_usage_daily", "gallery", "settings"]) {
    assert(tables.includes(table), `missing table ${table}`);
  }
  sql.close();
});

Deno.test("maskKey keeps four characters on each side", () => {
  assertEquals(maskKey("agk_1234567890abcd"), "agk_…abcd");
  assertEquals(maskKey("short"), "…");
});

Deno.test("accounts list masks keys and rejects duplicate names", async () => {
  const { sql, store } = await setup();
  const created = await store.create({ name: "main", apiKey: "agk_1234567890abcd" });
  assertEquals(created.name, "main");

  const list = await store.list();
  assertEquals(list.length, 1);
  assertEquals(list[0].apiKeyMasked, "agk_…abcd");
  assert(!("apiKey" in list[0]));

  const error = await assertRejects(
    () => store.create({ name: "main", apiKey: "agk_other" }),
    ApiError,
  );
  assertEquals(error.status, 409);
  sql.close();
});

Deno.test("claim hands out different accounts before repeating", async () => {
  const { sql, store } = await setup();
  const a = await store.create({ name: "a", apiKey: "key-a" });
  const b = await store.create({ name: "b", apiKey: "key-b" });

  const first = await store.claim();
  const second = await store.claim();
  assertEquals(first?.id, a.id);
  assertEquals(second?.id, b.id);
  assertEquals(first?.apiKey, "key-a");
  sql.close();
});

Deno.test("claim skips cooling-down and disabled accounts", async () => {
  const { sql, store } = await setup();
  const a = await store.create({ name: "a", apiKey: "key-a" });
  const b = await store.create({ name: "b", apiKey: "key-b" });

  await store.recordFailure(a.id, 60_000);
  assertEquals((await store.claim())?.id, b.id);
  assertEquals((await store.claim())?.id, b.id);

  // After the cooldown ends both are claimable again.
  await sql.execute("UPDATE accounts SET cooldown_until = ? WHERE id = ?", [
    new Date(Date.now() - 1000).toISOString(),
    a.id,
  ]);
  const claimed = await store.claim();
  assertEquals(claimed?.id, a.id);

  await store.update(b.id, { enabled: false });
  assertEquals((await store.claim())?.id, a.id);
  assertEquals((await store.claim())?.id, a.id);
  sql.close();
});

Deno.test("claim accepts an exclusion list", async () => {
  const { sql, store } = await setup();
  const a = await store.create({ name: "a", apiKey: "key-a" });
  const b = await store.create({ name: "b", apiKey: "key-b" });
  assertEquals((await store.claim([a.id]))?.id, b.id);
  assertEquals(await store.claim([a.id, b.id]), null);
  sql.close();
});

Deno.test("recordUpstreamSuccess accumulates upstream call and image counters", async () => {
  const { sql, store } = await setup();
  const account = await store.create({ name: "a", apiKey: "key-a" });
  await store.recordUpstreamSuccess(account.id, 2);
  await store.recordUpstreamSuccess(account.id, 3);
  const row = await store.get(account.id);
  assertEquals(row?.upstreamRequests, 2);
  assertEquals(row?.upstreamImages, 5);
  sql.close();
});

Deno.test("a stale success cannot clear a newer failure cooldown", async () => {
  const { sql, store } = await setup();
  const account = await store.create({ name: "a", apiKey: "key-a" });
  const claimed = await store.claim();
  await store.recordFailure(account.id, 60_000);
  await store.recordSuccess(account.id, claimed!.consecutiveFailures);
  const row = await store.get(account.id);
  assertEquals(row?.status, "degraded");
  assertEquals((row?.failCount ?? 0) > 0, true);
  await store.recordSuccess(account.id, row!.failCount);
  assertEquals((await store.get(account.id))?.status, "healthy");
  sql.close();
});

Deno.test("recordSuccess and resetHealth clear the cooldown", async () => {
  const { sql, store } = await setup();
  const account = await store.create({ name: "a", apiKey: "key-a" });
  await store.recordFailure(account.id, 60_000);
  assertEquals((await store.get(account.id))?.status, "degraded");

  await store.recordSuccess(account.id, 1);
  const row = await store.get(account.id);
  assertEquals(row?.status, "healthy");
  assertEquals(row?.failCount, 0);
  assertEquals(row?.cooldownUntil, null);

  await store.recordFailure(account.id, 60_000);
  await store.resetHealth(account.id);
  assertEquals((await store.get(account.id))?.cooldownUntil, null);
  sql.close();
});

Deno.test("update renames, toggles and rotates the key, remove deletes it", async () => {
  const { sql, store } = await setup();
  const account = await store.create({ name: "a", apiKey: "key-a" });
  await store.recordFailure(account.id, 60_000);
  await store.update(account.id, { name: "renamed", enabled: false, apiKey: "key-b" });
  const row = await store.get(account.id);
  assertEquals(row?.name, "renamed");
  assertEquals(row?.enabled, false);
  assertEquals(row?.apiKey, "key-b");
  assertEquals(row?.status, "healthy");
  assertEquals(row?.failCount, 0);
  assertEquals(row?.cooldownUntil, null);

  const error = await assertRejects(
    () => store.update(account.id, { apiKey: "  " }),
    ApiError,
  );
  assertEquals(error.status, 400);

  assert(await store.remove(account.id));
  assertEquals(await store.get(account.id), null);
  assert(!(await store.remove(account.id)));
  assertThrows(() => maskKey(""), Error);
  sql.close();
});
