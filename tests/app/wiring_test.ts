import { assert, assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { buildHarness } from "../../scripts/harness.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";
import type { AgnesClient } from "../../lib/pool.ts";
import type { SqlArg } from "../../lib/sql.ts";

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const TINY_B64 = encodeBase64(pngHeader(1024, 1024));

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
      body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "x", size: "2K" }),
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.data[0].b64_json, TINY_B64);
  // The response size comes from the image bytes, not the request expression.
  assertEquals(body.size, "1024x1024");
  assertEquals(response.headers.get("x-agnes-resolved-size"), "2K");
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
