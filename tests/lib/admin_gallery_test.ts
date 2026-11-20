import { assertEquals } from "@std/assert";
import { createAccountStore, ensureSchema } from "../../lib/accounts.ts";
import { createSessionSigner } from "../../lib/auth.ts";
import { createAdminApi } from "../../lib/admin.ts";
import { createGalleryStore, type GalleryStore } from "../../lib/gallery.ts";
import { createRequestLogStore } from "../../lib/logs.ts";
import { createModelUsageStore } from "../../lib/model-usage.ts";
import { createSettingsStore } from "../../lib/settings.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";
import type { AgnesClientFactory } from "../../lib/pool.ts";

const API_KEY = "proxy-key";

async function setup(): Promise<{
  sql: ReturnType<typeof createNodeSqliteExecutor>;
  gallery: GalleryStore;
  call: (path: string, init?: RequestInit) => Promise<Response>;
  anon: (path: string, init?: RequestInit) => Promise<Response>;
}> {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  const gallery = createGalleryStore(sql);
  const session = createSessionSigner(API_KEY);
  const createClient: AgnesClientFactory = () => ({
    generate: () => Promise.resolve({ status: 200, body: {} }),
  });
  const api = createAdminApi({
    store: createAccountStore(sql),
    settings: createSettingsStore(sql),
    logs: createRequestLogStore(sql),
    modelUsage: createModelUsageStore(sql),
    gallery,
    apiKey: API_KEY,
    session,
    createClient,
  });

  const call = (path: string, init: RequestInit = {}) => {
    const request = new Request(`https://proxy.test${path}`, {
      ...init,
      headers: { authorization: `Bearer ${API_KEY}`, ...(init.headers ?? {}) },
    });
    return api.handle(request, path.split("?")[0]);
  };

  const anon = (path: string, init: RequestInit = {}) =>
    api.handle(new Request(`https://proxy.test${path}`, init), path.split("?")[0]);

  return { sql, gallery, call, anon };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
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
    bytes: new Uint8Array([1, 2, 3, 4]),
    sourceUrl: null,
    ...overrides,
  };
}

Deno.test("gallery list paginates and never returns bytes", async () => {
  const { sql, gallery, call } = await setup();
  await gallery.record(row({ prompt: "first" }));
  await gallery.record(row({ prompt: "second" }));

  const response = await call("/admin/api/gallery?limit=2");
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.items.length, 2);
  assertEquals(body.nextBefore, null);
  assertEquals(body.items[0].prompt, "second");
  assertEquals("bytes" in body.items[0], false);

  assertEquals((await call("/admin/api/gallery?limit=0")).status, 400);
  assertEquals((await call("/admin/api/gallery?limit=101")).status, 400);
  sql.close();
});

Deno.test("gallery content returns bytes with private caching and nosniff", async () => {
  const { sql, gallery, call } = await setup();
  const id = await gallery.record(row());
  const response = await call(`/admin/api/gallery/${id}/content`);
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "image/png");
  assertEquals(response.headers.get("cache-control"), "private, max-age=300");
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));

  assertEquals((await call("/admin/api/gallery/999/content")).status, 404);
  sql.close();
});

Deno.test("gallery requires auth", async () => {
  const { sql, call, anon } = await setup();
  assertEquals((await anon("/admin/api/gallery")).status, 401);
  assertEquals((await call("/admin/api/gallery")).status, 200);
  sql.close();
});

Deno.test("gallery delete removes one row and clear empties the store", async () => {
  const { sql, gallery, call } = await setup();
  const id = await gallery.record(row());
  await gallery.record(row());

  const removed = await call(`/admin/api/gallery/${id}`, { method: "DELETE" });
  assertEquals(removed.status, 204);
  assertEquals((await call(`/admin/api/gallery/${id}/content`)).status, 404);
  assertEquals((await call(`/admin/api/gallery/${id}`, { method: "DELETE" })).status, 404);

  const cleared = await call("/admin/api/gallery", { method: "DELETE" });
  assertEquals(cleared.status, 204);
  assertEquals(await gallery.count(), 0);
  sql.close();
});
