import { assertEquals } from "@std/assert";
import { ensureSchema } from "../../lib/accounts.ts";
import { createModelUsageStore } from "../../lib/model-usage.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";

async function setup() {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  return { sql, usage: createModelUsageStore(sql) };
}

Deno.test("model usage accumulates requests, errors and images per day", async () => {
  const { sql, usage } = await setup();
  await usage.record({
    model: "m1",
    endpoint: "generations",
    day: "2026-11-20",
    ok: true,
    images: 2,
    at: "2026-11-20T10:00:00.000Z",
  });
  await usage.record({
    model: "m1",
    endpoint: "generations",
    day: "2026-11-20",
    ok: false,
    images: 1,
    at: "2026-11-20T11:00:00.000Z",
  });
  await usage.record({
    model: "m1",
    endpoint: "generations",
    day: "2026-11-20",
    ok: false,
    images: 0,
    at: "2026-11-20T12:00:00.000Z",
  });

  const rows = await usage.byDay("2026-11-20");
  const row = rows.get("m1");
  assertEquals(row?.requests, 2);
  assertEquals(row?.errors, 2);
  assertEquals(row?.images, 3);
  assertEquals(row?.lastUsedAt, "2026-11-20T12:00:00.000Z");
  sql.close();
});

Deno.test("model usage omits models with no records for the day", async () => {
  const { sql, usage } = await setup();
  await usage.record({
    model: "m1",
    endpoint: "generations",
    day: "2026-11-19",
    ok: true,
    images: 1,
    at: "2026-11-19T10:00:00.000Z",
  });
  const rows = await usage.byDay("2026-11-20");
  assertEquals(rows.size, 0);
  sql.close();
});

Deno.test("model usage aggregates daily totals across a range", async () => {
  const { sql, usage } = await setup();
  await usage.record({
    model: "m1",
    endpoint: "generations",
    day: "2026-11-18",
    ok: true,
    images: 2,
    at: "2026-11-18T10:00:00.000Z",
  });
  await usage.record({
    model: "m2",
    endpoint: "edits",
    day: "2026-11-18",
    ok: false,
    images: 0,
    at: "2026-11-18T11:00:00.000Z",
  });
  await usage.record({
    model: "m1",
    endpoint: "generations",
    day: "2026-11-20",
    ok: true,
    images: 3,
    at: "2026-11-20T10:00:00.000Z",
  });

  const range = await usage.byRange("2026-11-17", "2026-11-20");
  assertEquals(range.size, 2);
  assertEquals(range.get("2026-11-18"), { requests: 1, errors: 1, images: 2 });
  assertEquals(range.get("2026-11-20"), { requests: 1, errors: 0, images: 3 });
  assertEquals(await usage.byRange("2026-11-19", "2026-11-19"), new Map());
  sql.close();
});
