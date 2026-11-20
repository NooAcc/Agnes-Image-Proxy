import { assert, assertEquals } from "@std/assert";
import { buildHarness } from "../../scripts/harness.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";
import type { AgnesClient } from "../../lib/pool.ts";
import type { SqlArg } from "../../lib/sql.ts";

const TINY_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

function pngClient(): AgnesClient {
  return {
    generate: () =>
      Promise.resolve({
        status: 200,
        body: { created: 1, data: [{ b64_json: TINY_B64 }] },
      }),
  };
}

Deno.test("harness serves a generation end to end", async () => {
  const sql = createNodeSqliteExecutor();
  const harness = await buildHarness({
    apiKey: "proxy-key",
    sql,
    createClient: pngClient,
    archiver: { archive: () => Promise.resolve() },
  });
  await harness.store.create({ name: "main", apiKey: "upstream-key" });

  const response = await harness.handler(
    new Request("https://proxy.test/v1/images/generations", {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "x", size: "1024x1024" }),
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.data[0].b64_json, TINY_B64);
  sql.close();
});

Deno.test("deep health reports a broken database", async () => {
  const base = createNodeSqliteExecutor();
  let broken = false;
  const sql = {
    execute: (statement: string, args?: SqlArg[]) =>
      broken ? Promise.reject(new Error("db down")) : base.execute(statement, args),
    batch: (statements: { sql: string; args?: SqlArg[] }[]) => base.batch!(statements),
  };
  const harness = await buildHarness({
    apiKey: "proxy-key",
    sql,
    createClient: pngClient,
    archiver: { archive: () => Promise.resolve() },
  });

  assertEquals(
    (await harness.handler(new Request("https://proxy.test/health?deep=1"))).status,
    200,
  );
  broken = true;
  assertEquals(
    (await harness.handler(new Request("https://proxy.test/health?deep=1"))).status,
    503,
  );
  base.close();
});

Deno.test("admin shows the login page without a session", async () => {
  const sql = createNodeSqliteExecutor();
  const harness = await buildHarness({
    apiKey: "proxy-key",
    sql,
    createClient: pngClient,
    archiver: { archive: () => Promise.resolve() },
  });

  const anonymous = await harness.handler(new Request("https://proxy.test/admin"));
  assert((await anonymous.text()).includes("PROXY_API_KEY"));

  const authorized = await harness.handler(
    new Request("https://proxy.test/admin", {
      headers: { authorization: "Bearer proxy-key" },
    }),
  );
  assert((await authorized.text()).includes('data-section="overview"'));
  sql.close();
});
