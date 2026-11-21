import { assertEquals } from "@std/assert";
import { ensureSchema } from "../../lib/accounts.ts";
import { createGalleryStore } from "../../lib/gallery.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";

async function setup() {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  return { sql, gallery: createGalleryStore(sql) };
}

function insert(overrides: Record<string, unknown> = {}) {
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

Deno.test("gallery round-trips BLOB bytes", async () => {
  const { sql, gallery } = await setup();
  const id = await gallery.record(insert());
  assertEquals(typeof id, "number");

  const content = await gallery.content(id);
  assertEquals(content?.mime, "image/png");
  assertEquals(content?.bytes, new Uint8Array([1, 2, 3, 4]));

  const item = (await gallery.list(null, 10)).items[0];
  assertEquals(item.archived, true);
  assertEquals(item.byteSize, 4);
  assertEquals(item.sourceUrl, null);
  sql.close();
});

Deno.test("gallery records unarchived rows with only a source URL", async () => {
  const { sql, gallery } = await setup();
  const id = await gallery.record(
    insert({ bytes: null, sourceUrl: "https://example.com/a.png", mime: "image/png" }),
  );
  const item = (await gallery.list(null, 10)).items[0];
  assertEquals(item.archived, false);
  assertEquals(item.sourceUrl, "https://example.com/a.png");
  assertEquals(item.byteSize, 0);
  assertEquals(await gallery.content(id), null);
  sql.close();
});

Deno.test("gallery content refuses non-whitelisted MIME rows", async () => {
  const { sql, gallery } = await setup();
  const id = await gallery.record(
    insert({
      mime: "image/svg+xml",
      bytes: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    }),
  );
  assertEquals(await gallery.content(id), null);
  sql.close();
});

Deno.test("gallery paginates with an id cursor", async () => {
  const { sql, gallery } = await setup();
  for (let i = 0; i < 30; i++) await gallery.record(insert({ prompt: `p${i}` }));

  const first = await gallery.list(null, 24);
  assertEquals(first.items.length, 24);
  assertEquals(first.nextBefore !== null, true);
  assertEquals(first.items[0].prompt, "p29");

  const second = await gallery.list(first.nextBefore, 24);
  assertEquals(second.items.length, 6);
  assertEquals(second.nextBefore, null);
  assertEquals(second.items[5].prompt, "p0");
  sql.close();
});

Deno.test("gallery remove and clear", async () => {
  const { sql, gallery } = await setup();
  const id = await gallery.record(insert());
  await gallery.record(insert());
  assertEquals(await gallery.count(), 2);
  assertEquals(await gallery.remove(id), true);
  assertEquals(await gallery.remove(id), false);
  assertEquals(await gallery.count(), 1);
  await gallery.clear();
  assertEquals(await gallery.count(), 0);
  sql.close();
});
