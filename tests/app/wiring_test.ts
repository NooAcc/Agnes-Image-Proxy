import { assert, assertEquals } from "@std/assert";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { buildHarness } from "../../scripts/harness.ts";
import { DEFAULT_SETTINGS } from "../../lib/settings.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";
import type { AgnesClient } from "../../lib/pool.ts";
import type { SqlArg } from "../../lib/sql.ts";

const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const SCORES = {
  drawing: 0.02,
  hentai: 0.01,
  safe: 0.91,
  porn: 0.03,
  sexy: 0.03,
  isNsfw: false,
};

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

function edgeMetadataFetch(): typeof fetch {
  return ((_input, init) => {
    const items = JSON.parse(String(init?.body ?? "[]")) as { uuid: string; base64?: string }[];
    const results: Record<string, unknown> = {};
    for (const item of items) {
      if (!item.base64) {
        results[item.uuid] = { success: false, error: "no source" };
        continue;
      }
      const bytes = decodeBase64(item.base64);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      results[item.uuid] = {
        success: true,
        data: {
          width: view.getUint32(16),
          height: view.getUint32(20),
          format: "png",
          sourceContentType: "image/png",
        },
      };
    }
    return Promise.resolve(
      new Response(JSON.stringify(results), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

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
    fetchImpl: edgeMetadataFetch(),
  });
  await harness.store.create({ name: "main", apiKey: "upstream-key" });
  await harness.settings.write({ ...DEFAULT_SETTINGS, imageServiceBaseUrl: "https://img.example" });

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
  const failed = await harness.handler(new Request("https://proxy.test/health?deep=1"));
  assertEquals(failed.status, 503);
  const body = await failed.text();
  assert(!body.includes("db down"));
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

Deno.test("harness disables enrichment until an image service is configured", async () => {
  const sql = createNodeSqliteExecutor();
  const harness = await buildHarness({
    apiKey: "proxy-key",
    sql,
    createClient: pngClient,
    archiver: { archive: () => Promise.resolve() },
  });
  const response = await harness.handler(
    new Request("https://proxy.test/admin/api/gallery/enrich", {
      method: "POST",
      headers: { authorization: "Bearer proxy-key" },
    }),
  );
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error.code, "image_service_disabled");
  sql.close();
});

Deno.test("harness wires the enricher into the admin backfill endpoint", async () => {
  const sql = createNodeSqliteExecutor();
  const calls: string[] = [];
  const harness = await buildHarness({
    apiKey: "proxy-key",
    sql,
    createClient: pngClient,
    archiver: { archive: () => Promise.resolve() },
    fetchImpl: (input) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            "1": {
              success: true,
              data: { base64: encodeBase64(WEBP), contentType: "image/webp", nsfw: SCORES },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  });
  await harness.settings.write({ ...DEFAULT_SETTINGS, imageServiceBaseUrl: "https://img.example" });
  await harness.gallery.record({
    ts: "2026-11-20T10:00:00.000Z",
    endpoint: "generations",
    model: "agnes-image-2.5-flash",
    accountId: 1,
    accountName: "main",
    prompt: "a cat",
    size: "1024x1024",
    tier: "1K",
    ratio: "1:1",
    mime: "image/png",
    bytes: pngHeader(1024, 1024),
    sourceUrl: null,
  });

  const response = await harness.handler(
    new Request("https://proxy.test/admin/api/gallery/enrich", {
      method: "POST",
      headers: { authorization: "Bearer proxy-key" },
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.succeeded, 1);
  assertEquals(calls, ["https://img.example/api/batch"]);
  sql.close();
});
