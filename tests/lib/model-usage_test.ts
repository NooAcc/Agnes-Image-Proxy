import { assertEquals } from "@std/assert";
import { ensureSchema } from "../../lib/accounts.ts";
import { createModelUsageStore } from "../../lib/model-usage.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";

async function setup() {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  return { sql, usage: createModelUsageStore(sql) };
}

Deno.test("model usage accumulates five fields per day", async () => {
  const { sql, usage } = await setup();
  const at = "2026-11-21T12:00:00.000Z";
  await usage.record({ model: "m", day: "2026-11-21", images: 0, requested: 2, failed: 2, at });
  await usage.record({ model: "m", day: "2026-11-21", images: 1, requested: 2, failed: 1, at });
  await usage.record({ model: "m", day: "2026-11-21", images: 2, requested: 2, failed: 0, at });
  const row = (await usage.byDay("2026-11-21")).get("m")!;
  assertEquals(row, {
    requests: 3,
    successes: 2,
    partials: 1,
    failures: 1,
    images: 3,
    lastUsedAt: at,
  });
  assertEquals(row.requests, row.successes + row.failures);
  sql.close();
});

Deno.test("model usage omits models with no records for the day", async () => {
  const { sql, usage } = await setup();
  await usage.record({
    model: "m1",
    day: "2026-11-19",
    images: 1,
    requested: 1,
    failed: 0,
    at: "2026-11-19T10:00:00.000Z",
  });
  const rows = await usage.byDay("2026-11-20");
  assertEquals(rows.size, 0);
  sql.close();
});

Deno.test("model usage aggregates five daily totals across a range", async () => {
  const { sql, usage } = await setup();
  await usage.record({
    model: "m1",
    day: "2026-11-18",
    images: 2,
    requested: 2,
    failed: 0,
    at: "2026-11-18T10:00:00.000Z",
  });
  await usage.record({
    model: "m2",
    day: "2026-11-18",
    images: 0,
    requested: 1,
    failed: 1,
    at: "2026-11-18T11:00:00.000Z",
  });
  await usage.record({
    model: "m1",
    day: "2026-11-20",
    images: 3,
    requested: 3,
    failed: 0,
    at: "2026-11-20T10:00:00.000Z",
  });

  const range = await usage.byRange("2026-11-17", "2026-11-20");
  assertEquals(range.size, 2);
  assertEquals(range.get("2026-11-18"), {
    requests: 2,
    successes: 1,
    partials: 0,
    failures: 1,
    images: 2,
  });
  assertEquals(range.get("2026-11-20"), {
    requests: 1,
    successes: 1,
    partials: 0,
    failures: 0,
    images: 3,
  });
  assertEquals(await usage.byRange("2026-11-19", "2026-11-19"), new Map());
  sql.close();
});
