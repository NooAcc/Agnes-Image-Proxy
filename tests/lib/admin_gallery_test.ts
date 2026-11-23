import { assertEquals } from "@std/assert";
import { createAccountStore, ensureSchema } from "../../lib/accounts.ts";
import { createAuthStateStore, createSessionService } from "../../lib/auth.ts";
import { createAdminApi } from "../../lib/admin.ts";
import type { Enricher } from "../../lib/enrich.ts";
import {
  createGalleryStore,
  type EnrichInput,
  type EnrichmentWrite,
  type GalleryStore,
  type NsfwScores,
} from "../../lib/gallery.ts";
import { createRequestLogStore, type RequestLogStore } from "../../lib/logs.ts";
import { createModelUsageStore } from "../../lib/model-usage.ts";
import { createSettingsStore } from "../../lib/settings.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";
import type { AgnesClientFactory } from "../../lib/pool.ts";

const API_KEY = "proxy-key";
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const NSFW: NsfwScores = {
  drawing: 0.02,
  hentai: 0.01,
  safe: 0.91,
  porn: 0.03,
  sexy: 0.03,
  isNsfw: false,
};

function enrichment(tag: string | null): EnrichmentWrite {
  return {
    thumb: WEBP,
    thumbMime: "image/webp",
    nsfw: tag === null ? null : NSFW,
    tag,
    status: "ok",
    error: null,
    at: "2026-11-22T10:00:00.000Z",
  };
}

async function setup(enricherFactory?: (gallery: GalleryStore) => Enricher): Promise<{
  sql: ReturnType<typeof createNodeSqliteExecutor>;
  gallery: GalleryStore;
  logs: RequestLogStore;
  call: (path: string, init?: RequestInit) => Promise<Response>;
  anon: (path: string, init?: RequestInit) => Promise<Response>;
}> {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  const gallery = createGalleryStore(sql);
  const logs = createRequestLogStore(sql);
  const session = createSessionService(API_KEY, createAuthStateStore(sql));
  const createClient: AgnesClientFactory = () => ({
    generate: () => Promise.resolve({ status: 200, body: {} }),
  });
  const api = createAdminApi({
    store: createAccountStore(sql),
    settings: createSettingsStore(sql),
    logs,
    modelUsage: createModelUsageStore(sql),
    gallery,
    apiKey: API_KEY,
    session,
    createClient,
    enricher: enricherFactory?.(gallery),
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

  return { sql, gallery, logs, call, anon };
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

Deno.test("gallery content is immutable-cached with CSP and inline disposition", async () => {
  const { sql, gallery, call } = await setup();
  const id = await gallery.record(row());
  const response = await call(`/admin/api/gallery/${id}/content`);
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "image/png");
  assertEquals(
    response.headers.get("cache-control"),
    "private, max-age=31536000, immutable",
  );
  assertEquals(
    response.headers.get("content-security-policy"),
    "default-src 'none'; sandbox",
  );
  assertEquals(response.headers.get("content-disposition"), "inline");
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));

  const missing = await call("/admin/api/gallery/999/content");
  assertEquals(missing.status, 404);
  assertEquals(missing.headers.get("cache-control"), "no-store");
  sql.close();
});

Deno.test("gallery content rejects non-whitelisted MIME rows", async () => {
  const { sql, gallery, call } = await setup();
  const id = await gallery.record(
    row({ mime: "image/svg+xml", bytes: new TextEncoder().encode("<svg/>") }),
  );
  assertEquals((await call(`/admin/api/gallery/${id}/content`)).status, 404);
  sql.close();
});

Deno.test("gallery requires auth", async () => {
  const { sql, call, anon } = await setup();
  const unauthorized = await anon("/admin/api/gallery");
  assertEquals(unauthorized.status, 401);
  assertEquals(unauthorized.headers.get("cache-control"), "no-store");
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

Deno.test("gallery list filters by tag and rejects unknown tags", async () => {
  const { sql, gallery, call } = await setup();
  const safe = await gallery.record(row({ prompt: "n" }));
  const porn = await gallery.record(row({ prompt: "p" }));
  await gallery.record(row({ prompt: "u" }));
  // A tag without a thumbnail must still be categorized.
  await gallery.setEnrichment(safe, { ...enrichment("safe"), thumb: null, thumbMime: null });
  await gallery.setEnrichment(porn, enrichment("porn"));

  const bySafe = await (await call("/admin/api/gallery?tag=safe")).json();
  assertEquals(bySafe.items.map((item: { prompt: string }) => item.prompt), ["n"]);
  assertEquals(bySafe.items[0].hasThumbnail, false);
  const byUncategorized = await (await call("/admin/api/gallery?tag=uncategorized")).json();
  assertEquals(byUncategorized.items.map((item: { prompt: string }) => item.prompt), ["u"]);

  const bogus = await call("/admin/api/gallery?tag=bogus");
  assertEquals(bogus.status, 400);
  const body = await bogus.json();
  assertEquals(body.error.param, "tag");
  sql.close();
});

Deno.test("gallery thumbnail serves stored bytes and 404s without one", async () => {
  const { sql, gallery, call } = await setup();
  const withThumb = await gallery.record(row());
  const without = await gallery.record(row());
  await gallery.setEnrichment(withThumb, enrichment("safe"));

  const response = await call(`/admin/api/gallery/${withThumb}/thumbnail`);
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "image/webp");
  assertEquals(
    response.headers.get("cache-control"),
    "private, max-age=31536000, immutable",
  );
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(new Uint8Array(await response.arrayBuffer()), WEBP);

  assertEquals((await call(`/admin/api/gallery/${without}/thumbnail`)).status, 404);
  sql.close();
});

Deno.test("gallery enrich requires a configured image service", async () => {
  const { sql, call } = await setup();
  const response = await call("/admin/api/gallery/enrich", { method: "POST" });
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error.code, "image_service_disabled");
  sql.close();
});

Deno.test("gallery enrich reports progress and advances past a full page", async () => {
  const { sql, gallery, call } = await setup(() => ({
    enabled: () => Promise.resolve(true),
    enrich: (rows) =>
      Promise.resolve({ processed: rows.length, succeeded: 0, failed: rows.length }),
  }));
  for (let i = 0; i < 20; i++) await gallery.record(row({ prompt: `p${i}` }));

  const first = await (await call("/admin/api/gallery/enrich", { method: "POST" })).json();
  assertEquals(first.processed, 20);
  assertEquals(first.failed, 20);
  assertEquals(first.remaining, 20);
  assertEquals(first.nextBefore, 1);

  const second = await (await call("/admin/api/gallery/enrich", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ before: first.nextBefore }),
  })).json();
  assertEquals(second.processed, 0);
  assertEquals(second.nextBefore, null);
  sql.close();
});

Deno.test("gallery enrich marks oversized rows failed without asking the enricher", async () => {
  const received: EnrichInput[] = [];
  const { sql, gallery, call } = await setup(() => ({
    enabled: () => Promise.resolve(true),
    enrich: (rows) => {
      received.push(...rows);
      return Promise.resolve({ processed: rows.length, succeeded: rows.length, failed: 0 });
    },
  }));
  const id = await gallery.record(row());
  await sql.execute("UPDATE gallery SET byte_size = ? WHERE id = ?", [52428801, id]);

  const body = await (await call("/admin/api/gallery/enrich", { method: "POST" })).json();
  assertEquals(received.length, 0);
  assertEquals(body.processed, 1);
  assertEquals(body.failed, 1);
  const item = (await gallery.list(null, 10)).items[0];
  assertEquals(item.enrichStatus, "failed");
  sql.close();
});

Deno.test("gallery enrich marks a short page complete", async () => {
  const { sql, gallery, call } = await setup((gallery) => ({
    enabled: () => Promise.resolve(true),
    enrich: async (rows) => {
      for (const item of rows) {
        await gallery.setEnrichment(item.id, enrichment("safe"));
      }
      return { processed: rows.length, succeeded: rows.length, failed: 0 };
    },
  }));
  for (let i = 0; i < 3; i++) await gallery.record(row());

  const body = await (await call("/admin/api/gallery/enrich", { method: "POST" })).json();
  assertEquals(body, {
    processed: 3,
    succeeded: 3,
    failed: 0,
    remaining: 0,
    nextBefore: null,
  });
  sql.close();
});

Deno.test("url rows do not consume the byte budget or get locally failed", async () => {
  const received: EnrichInput[] = [];
  const { sql, gallery, call } = await setup(() => ({
    enabled: () => Promise.resolve(true),
    enrich: (rows) => {
      received.push(...rows);
      return Promise.resolve({ processed: rows.length, succeeded: rows.length, failed: 0 });
    },
  }));
  const byteRow = await gallery.record(row({ prompt: "bytes" }));
  const urlRow = await gallery.record(
    row({ prompt: "url", bytes: null, sourceUrl: "https://agnes.example/a.png" }),
  );
  await sql.execute("UPDATE gallery SET byte_size = ? WHERE id = ?", [1 * 1024 * 1024, byteRow]);
  await sql.execute("UPDATE gallery SET byte_size = ? WHERE id = ?", [60 * 1024 * 1024, urlRow]);

  const body = await (await call("/admin/api/gallery/enrich", { method: "POST" })).json();
  assertEquals(received.map((item) => item.id).sort(), [byteRow, urlRow].sort());
  assertEquals(body.processed, 2);
  assertEquals(body.failed, 0);
  sql.close();
});

Deno.test("gallery enrich logs image-info runs apart from client requests", async () => {
  const { sql, gallery, logs, call } = await setup((gallery) => ({
    enabled: () => Promise.resolve(true),
    enrich: async (rows) => {
      for (const item of rows) {
        await gallery.setEnrichment(item.id, enrichment("safe"));
      }
      return { processed: rows.length, succeeded: rows.length, failed: 0 };
    },
  }));
  await gallery.record(row());

  await call("/admin/api/gallery/enrich", { method: "POST" });
  const [entry] = await logs.list(1);
  assertEquals(entry.category, "enrich");
  assertEquals(entry.endpoint, "gallery/enrich");
  assertEquals(entry.requested, 1);
  assertEquals(entry.images, 1);
  assertEquals(entry.failed, 0);
  assertEquals(entry.ok, true);
  sql.close();
});

Deno.test("gallery enrich logs failures and skips no-op runs", async () => {
  const { sql, gallery, logs, call } = await setup(() => ({
    enabled: () => Promise.resolve(true),
    enrich: (rows) =>
      Promise.resolve({ processed: rows.length, succeeded: 0, failed: rows.length }),
  }));

  await call("/admin/api/gallery/enrich", { method: "POST" });
  assertEquals(await logs.count(), 0);

  await gallery.record(row());
  await call("/admin/api/gallery/enrich", { method: "POST" });
  const [entry] = await logs.list(1);
  assertEquals(entry.category, "enrich");
  assertEquals(entry.ok, false);
  assertEquals(entry.status, 502);
  assertEquals(entry.failed, 1);
  assertEquals(entry.errorCode, "enrich_failed");
  sql.close();
});

Deno.test("gallery enrich stops at the byte budget and resumes without skipping", async () => {
  const pages: number[][] = [];
  const { sql, gallery, call } = await setup((gallery) => ({
    enabled: () => Promise.resolve(true),
    enrich: async (rows) => {
      pages.push(rows.map((item) => item.id));
      for (const item of rows) {
        await gallery.setEnrichment(item.id, enrichment("safe"));
      }
      return { processed: rows.length, succeeded: rows.length, failed: 0 };
    },
  }));
  const oldest = await gallery.record(row({ prompt: "a" }));
  const middle = await gallery.record(row({ prompt: "b" }));
  const newest = await gallery.record(row({ prompt: "c" }));
  await sql.execute("UPDATE gallery SET byte_size = ? WHERE id = ?", [
    1 * 1024 * 1024,
    oldest,
  ]);
  await sql.execute("UPDATE gallery SET byte_size = ? WHERE id = ?", [
    20 * 1024 * 1024,
    middle,
  ]);
  await sql.execute("UPDATE gallery SET byte_size = ? WHERE id = ?", [
    20 * 1024 * 1024,
    newest,
  ]);

  const first = await (await call("/admin/api/gallery/enrich", { method: "POST" })).json();
  assertEquals(first.processed, 1);
  assertEquals(first.nextBefore, newest);
  assertEquals(pages.length, 1);
  assertEquals(pages[0], [newest]);

  const second = await (await call("/admin/api/gallery/enrich", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ before: first.nextBefore }),
  })).json();
  assertEquals(second.processed, 2);
  assertEquals(second.nextBefore, null);
  assertEquals(second.remaining, 0);
  assertEquals(pages.length, 2);
  // readForEnrichment uses IN (...), whose row order is not guaranteed.
  assertEquals(
    pages[1].slice().sort((a, b) => a - b),
    [middle, oldest].sort((a, b) => a - b),
  );
  sql.close();
});
