import { assertEquals } from "@std/assert";
import { ensureSchema } from "../../lib/accounts.ts";
import { createRequestLogStore, type RequestLogInput } from "../../lib/logs.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";

async function setup() {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  return { sql, logs: createRequestLogStore(sql) };
}

function entry(overrides: Partial<RequestLogInput> = {}): RequestLogInput {
  return {
    requestId: "req-1",
    ts: "2026-11-20T10:00:00.000Z",
    stage: "complete",
    endpoint: "generations",
    path: "/v1/images/generations",
    model: "agnes-image-2.5-flash",
    accountId: 1,
    accountName: "main",
    status: 200,
    ok: true,
    durationMs: 1200,
    requested: 1,
    images: 1,
    failed: 0,
    sizeRequest: "1K 1:1",
    sizeActual: "900x1200",
    errorCode: null,
    error: null,
    attempts: [{ index: 0, traces: [] }],
    ...overrides,
  };
}

Deno.test("request logs keep only the latest 500 rows, newest first", async () => {
  const { sql, logs } = await setup();
  for (let i = 0; i < 505; i++) {
    await logs.record(entry({ ts: `2026-11-20T10:00:${String(i % 60).padStart(2, "0")}.000Z` }));
  }
  assertEquals(await logs.count(), 500);
  const rows = await logs.list(5);
  assertEquals(rows.length, 5);
  const ids = rows.map((row) => row.id);
  assertEquals(ids, [...ids].sort((a, b) => b - a));
  sql.close();
});

Deno.test("request logs round-trip the stage fields", async () => {
  const { sql, logs } = await setup();
  await logs.record(entry());
  const row = (await logs.list())[0];
  assertEquals(row.requestId, "req-1");
  assertEquals(row.stage, "complete");
  assertEquals(row.sizeRequest, "1K 1:1");
  assertEquals(row.sizeActual, "900x1200");
  assertEquals(row.errorCode, null);
  sql.close();
});

Deno.test("request logs round-trip counts and the attempts JSON", async () => {
  const { sql, logs } = await setup();
  await logs.record(entry({ requested: 5, images: 3, failed: 2, ok: false }));
  const row = (await logs.list())[0];
  assertEquals(row.requested, 5);
  assertEquals(row.images, 3);
  assertEquals(row.failed, 2);
  assertEquals(row.ok, false);
  assertEquals(row.attempts, [{ index: 0, traces: [] }]);
  sql.close();
});

Deno.test("clear empties the log", async () => {
  const { sql, logs } = await setup();
  await logs.record(entry());
  await logs.clear();
  assertEquals(await logs.count(), 0);
  sql.close();
});
