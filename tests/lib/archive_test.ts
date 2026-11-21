import { assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { createArchiver, isPublicHttpsUrl, sniffImageMime } from "../../lib/archive.ts";
import type { GalleryInsert, GalleryStore } from "../../lib/gallery.ts";

const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0,
  0,
  0,
  0,
  0x49,
  0x48,
  0x44,
  0x52,
  0,
  0,
  0,
  2,
  0,
  0,
  0,
  3,
]);

function fakeGallery() {
  const rows: GalleryInsert[] = [];
  const failFirst = { enabled: false };
  const store: GalleryStore = {
    record: (input) => {
      if (failFirst.enabled) {
        failFirst.enabled = false;
        return Promise.reject(new Error("row too large"));
      }
      rows.push(input);
      return Promise.resolve(rows.length);
    },
    list: () => Promise.resolve({ items: [], nextBefore: null }),
    content: () => Promise.resolve(null),
    remove: () => Promise.resolve(false),
    clear: () => Promise.resolve(),
    count: () => Promise.resolve(rows.length),
  };
  return { store, rows, failFirst };
}

function request(images: { url: string | null; b64_json: string | null }[]) {
  return {
    ts: "2026-11-20T10:00:00.000Z",
    endpoint: "generations",
    model: "m",
    accountId: 1,
    accountName: "main",
    prompt: "p",
    size: "1024x1024",
    tier: "1K",
    ratio: "1:1",
    images: images.map((image) => ({ ...image, revised_prompt: null })),
  };
}

function pngResponse(bytes: Uint8Array = PNG): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": "image/png", "content-length": String(bytes.length) },
  });
}

function pngWithSize(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

Deno.test("gallery stores the actual size of a b64 image", async () => {
  const gallery = fakeGallery();
  const archiver = createArchiver({ gallery: gallery.store });
  const bytes = pngWithSize(900, 1200);
  await archiver.archive(request([{ url: null, b64_json: encodeBase64(bytes) }]));
  assertEquals(gallery.rows[0].size, "900x1200");
});

Deno.test("gallery stores the actual size of a downloaded URL image", async () => {
  const gallery = fakeGallery();
  const bytes = pngWithSize(1024, 1024);
  const archiver = createArchiver({
    gallery: gallery.store,
    fetchImpl: () => Promise.resolve(pngResponse(bytes)),
  });
  await archiver.archive(request([{ url: "https://out.example/a.png", b64_json: null }]));
  assertEquals(gallery.rows[0].size, "1024x1024");
});

Deno.test("gallery falls back to the request size when no bytes are available", async () => {
  const gallery = fakeGallery();
  const archiver = createArchiver({
    gallery: gallery.store,
    fetchImpl: () => Promise.reject(new Error("boom")),
  });
  await archiver.archive(request([{ url: "https://out.example/a.png", b64_json: null }]));
  assertEquals(gallery.rows[0].size, "1024x1024");
  assertEquals(gallery.rows[0].bytes, null);
});

Deno.test("sniffImageMime detects PNG, JPEG and WebP", () => {
  assertEquals(sniffImageMime(PNG), "image/png");
  assertEquals(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assertEquals(
    sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    "image/webp",
  );
  assertEquals(sniffImageMime(new Uint8Array([1, 2, 3])), null);
});

Deno.test("an SVG download is recorded as an unarchived octet-stream row", async () => {
  const { store, rows } = fakeGallery();
  const archiver = createArchiver({
    gallery: store,
    fetchImpl: () =>
      Promise.resolve(
        new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        }),
      ),
  });
  await archiver.archive(request([{ url: "https://example.com/a.svg", b64_json: null }]));
  assertEquals(rows[0].bytes, null);
  assertEquals(rows[0].mime, "application/octet-stream");
  assertEquals(rows[0].sourceUrl, "https://example.com/a.svg");
});

Deno.test("an SVG or garbage b64 payload is not stored as bytes", async () => {
  const { store, rows } = fakeGallery();
  const archiver = createArchiver({ gallery: store });
  const svg = encodeBase64(
    new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
  );
  await archiver.archive(request([{ url: null, b64_json: svg }]));
  await archiver.archive(
    request([{ url: null, b64_json: encodeBase64(new Uint8Array([1, 2, 3])) }]),
  );
  assertEquals(rows[0].bytes, null);
  assertEquals(rows[0].mime, "application/octet-stream");
  assertEquals(rows[0].sourceUrl, null);
  assertEquals(rows[1].bytes, null);
  assertEquals(rows[1].mime, "application/octet-stream");
});

Deno.test("isPublicHttpsUrl rejects loopback and private hosts", () => {
  assertEquals(isPublicHttpsUrl("https://platform-outputs.agnes-ai.space/a.png"), true);
  assertEquals(isPublicHttpsUrl("https://example.com/a.png"), true);
  assertEquals(isPublicHttpsUrl("http://example.com/a.png"), false);
  assertEquals(isPublicHttpsUrl("https://127.0.0.1/a.png"), false);
  assertEquals(isPublicHttpsUrl("https://10.0.0.5/a.png"), false);
  assertEquals(isPublicHttpsUrl("https://172.20.0.1/a.png"), false);
  assertEquals(isPublicHttpsUrl("https://192.168.1.1/a.png"), false);
  assertEquals(isPublicHttpsUrl("https://[::1]/a.png"), false);
  assertEquals(isPublicHttpsUrl("https://localhost/a.png"), false);
});

Deno.test("archives base64 images into BLOB bytes", async () => {
  const { store, rows } = fakeGallery();
  const archiver = createArchiver({ gallery: store });
  await archiver.archive(request([{ url: null, b64_json: encodeBase64(PNG) }]));
  assertEquals(rows.length, 1);
  assertEquals(rows[0].mime, "image/png");
  assertEquals(rows[0].bytes, PNG);
  assertEquals(rows[0].sourceUrl, null);
});

Deno.test("invalid base64 records an unarchived row without throwing", async () => {
  const { store, rows } = fakeGallery();
  const archiver = createArchiver({ gallery: store });
  await archiver.archive(request([{ url: null, b64_json: "not base64 %%%" }]));
  assertEquals(rows.length, 1);
  assertEquals(rows[0].bytes, null);
  assertEquals(rows[0].sourceUrl, null);
});

Deno.test("downloads a public https output URL", async () => {
  const calls: string[] = [];
  const { store, rows } = fakeGallery();
  const archiver = createArchiver({
    gallery: store,
    fetchImpl: (input) => {
      calls.push(String(input));
      return Promise.resolve(pngResponse());
    },
  });
  await archiver.archive(request([{
    url: "https://platform-outputs.agnes-ai.space/images/t2i/task_x/output.png",
    b64_json: null,
  }]));
  assertEquals(calls, ["https://platform-outputs.agnes-ai.space/images/t2i/task_x/output.png"]);
  assertEquals(rows[0].bytes, PNG);
  assertEquals(rows[0].mime, "image/png");
});

Deno.test("never fetches private or non-https URLs", async () => {
  let calls = 0;
  const { store, rows } = fakeGallery();
  const archiver = createArchiver({
    gallery: store,
    fetchImpl: () => {
      calls++;
      return Promise.resolve(pngResponse());
    },
  });
  await archiver.archive(request([
    { url: "http://example.com/a.png", b64_json: null },
    { url: "https://127.0.0.1/a.png", b64_json: null },
    { url: "https://10.0.0.5/a.png", b64_json: null },
    { url: "https://[::1]/a.png", b64_json: null },
  ]));
  assertEquals(calls, 0);
  assertEquals(rows.length, 4);
  assertEquals(rows.every((row) => row.bytes === null && row.sourceUrl !== null), true);
});

Deno.test("rejects non-image responses, oversized bodies and private redirects", async () => {
  const { store, rows } = fakeGallery();
  const htmlArchiver = createArchiver({
    gallery: store,
    fetchImpl: () =>
      Promise.resolve(
        new Response("<html>nope</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
  });
  await htmlArchiver.archive(request([{ url: "https://example.com/a.png", b64_json: null }]));
  assertEquals(rows[0].bytes, null);

  const hugeArchiver = createArchiver({
    gallery: store,
    fetchImpl: () =>
      Promise.resolve(
        new Response("x", {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(65 * 1024 * 1024),
          },
        }),
      ),
  });
  await hugeArchiver.archive(request([{ url: "https://example.com/b.png", b64_json: null }]));
  assertEquals(rows[1].bytes, null);

  const redirectArchiver = createArchiver({
    gallery: store,
    fetchImpl: () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://10.0.0.5/secret.png" },
        }),
      ),
  });
  await redirectArchiver.archive(request([{ url: "https://example.com/c.png", b64_json: null }]));
  assertEquals(rows[2].bytes, null);
  assertEquals(rows[2].sourceUrl, "https://example.com/c.png");
});

Deno.test("download failures keep the source URL and never throw", async () => {
  const { store, rows } = fakeGallery();
  const archiver = createArchiver({
    gallery: store,
    fetchImpl: () => Promise.reject(new Error("network down")),
  });
  await archiver.archive(request([{ url: "https://example.com/a.png", b64_json: null }]));
  assertEquals(rows[0].bytes, null);
  assertEquals(rows[0].sourceUrl, "https://example.com/a.png");
});

Deno.test("a failed BLOB write falls back to source_url", async () => {
  const { store, rows, failFirst } = fakeGallery();
  failFirst.enabled = true;
  const archiver = createArchiver({
    gallery: store,
    fetchImpl: () => Promise.resolve(pngResponse()),
  });
  await archiver.archive(request([{ url: "https://example.com/a.png", b64_json: null }]));
  assertEquals(rows.length, 1);
  assertEquals(rows[0].bytes, null);
  assertEquals(rows[0].sourceUrl, "https://example.com/a.png");
});

Deno.test("archive uses waitUntil when provided", async () => {
  const { store, rows } = fakeGallery();
  const scheduled: Promise<unknown>[] = [];
  const archiver = createArchiver({
    gallery: store,
    waitUntil: (promise) => scheduled.push(promise),
  });
  await archiver.archive(request([{ url: null, b64_json: encodeBase64(PNG) }]));
  assertEquals(scheduled.length, 1);
  await scheduled[0];
  assertEquals(rows.length, 1);
});
