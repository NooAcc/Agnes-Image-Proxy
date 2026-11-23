import { assertEquals } from "@std/assert";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { chunkByBudget, createEnricher, type EnrichReport, tagForNsfw } from "../../lib/enrich.ts";
import type { EnrichInput, EnrichmentWrite, NsfwScores } from "../../lib/gallery.ts";
import { type AppSettings, DEFAULT_SETTINGS, type SettingsStore } from "../../lib/settings.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const SCORES = {
  drawing: 0.02,
  hentai: 0.01,
  safe: 0.91,
  porn: 0.03,
  sexy: 0.03,
  isNsfw: false,
};

/** A source image larger than WEBP so a returned thumbnail is strictly smaller. */
const SOURCE = new Uint8Array([...PNG, 9, 9, 9, 9, 9, 9, 9, 9]);

function fakeSettings(overrides: Partial<AppSettings> = {}): SettingsStore {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  return {
    read: () => Promise.resolve(settings),
    write: () => Promise.resolve(),
  };
}

function recorder() {
  const writes: { id: number; input: EnrichmentWrite }[] = [];
  return {
    writes,
    gallery: {
      setEnrichment: (id: number, input: EnrichmentWrite) => {
        writes.push({ id, input });
        return Promise.resolve();
      },
    },
  };
}

function row(id: number, overrides: Partial<EnrichInput> = {}): EnrichInput {
  return {
    id,
    mime: "image/png",
    url: null,
    bytes: SOURCE,
    sourceBytes: SOURCE.byteLength,
    ...overrides,
  };
}

Deno.test("enrich posts the documented batch shape and stores the result", async () => {
  const { writes, gallery } = recorder();
  let capturedUrl = "";
  let capturedBody: unknown = null;
  const enricher = createEnricher({
    settings: fakeSettings({ imageServiceBaseUrl: "https://img.example" }),
    gallery,
    fetchImpl: (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            "7": {
              success: true,
              data: {
                base64: encodeBase64(WEBP),
                contentType: "image/webp",
                nsfw: SCORES,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  });

  const report = await enricher.enrich([row(7)]);

  assertEquals(capturedUrl, "https://img.example/api/batch");
  assertEquals(Array.isArray(capturedBody), true);
  const body = capturedBody as {
    uuid: string;
    base64: string;
    contentType: string;
    params: Record<string, unknown>;
  }[];
  assertEquals(body.length, 1);
  assertEquals(body[0].uuid, "7");
  assertEquals(body[0].contentType, "image/png");
  assertEquals(decodeBase64(body[0].base64), SOURCE);
  assertEquals(body[0].params, {
    width: 640,
    height: 640,
    crop: "none",
    size: "down",
    format: "webp",
    quality: 75,
    nsfw: 1,
  });

  assertEquals(writes.length, 1);
  assertEquals(writes[0].id, 7);
  assertEquals(writes[0].input.tag, "safe");
  assertEquals(writes[0].input.thumb, WEBP);
  assertEquals(writes[0].input.thumbMime, "image/webp");
  assertEquals(writes[0].input.status, "ok");
  assertEquals(writes[0].input.nsfw, SCORES);
  assertEquals(report, { processed: 1, succeeded: 1, failed: 0 });
});

Deno.test("tagForNsfw uses a fixed tie order", () => {
  const tied: NsfwScores = {
    drawing: 0.2,
    hentai: 0.2,
    safe: 0.2,
    porn: 0.2,
    sexy: 0.2,
    isNsfw: false,
  };
  assertEquals(tagForNsfw(tied), "safe");
  assertEquals(tagForNsfw({ ...tied, porn: 0.9 }), "porn");
});

Deno.test("enrich fails items without nsfw and records the batch error", async () => {
  const { writes, gallery } = recorder();
  const enricher = createEnricher({
    settings: fakeSettings({ imageServiceBaseUrl: "https://img.example" }),
    gallery,
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            "1": { success: false, error: "nsfw: classifier is not available" },
            "2": {
              success: true,
              data: { base64: encodeBase64(WEBP), contentType: "image/webp" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  });

  const report = await enricher.enrich([row(1), row(2)]);

  assertEquals(report, { processed: 2, succeeded: 0, failed: 2 });
  assertEquals(writes.length, 2);
  assertEquals(writes[0].input.status, "failed");
  assertEquals(writes[0].input.error, "nsfw: classifier is not available");
  assertEquals(writes[1].input.status, "failed");
  assertEquals(writes[1].input.error?.startsWith("nsfw:"), true);
});

Deno.test("enrich is a no-op when the service URL is empty", async () => {
  const { writes, gallery } = recorder();
  let calls = 0;
  const enricher = createEnricher({
    settings: fakeSettings({ imageServiceBaseUrl: "" }),
    gallery,
    fetchImpl: () => {
      calls++;
      return Promise.reject(new Error("should not be called"));
    },
  });

  const report = await enricher.enrich([row(1)]);
  assertEquals(calls, 0);
  assertEquals(report, { processed: 0, succeeded: 0, failed: 0 });
  assertEquals(writes.length, 0);
  assertEquals(await enricher.enabled(), false);
});

Deno.test("chunkByBudget respects item and byte budgets", () => {
  const a = { bytes: new Uint8Array(10) };
  const b = { bytes: new Uint8Array(20) };
  const c = { bytes: new Uint8Array(30) };
  assertEquals(chunkByBudget([a, b, c], 20, 32), [[a, b], [c]]);

  const singles = Array.from({ length: 21 }, () => ({ bytes: new Uint8Array(1) }));
  const chunks = chunkByBudget(singles, 20, 1024);
  assertEquals(chunks.map((chunk) => chunk.length), [20, 1]);
});

Deno.test("enrich does not store a thumbnail that is not smaller than the source", async () => {
  const { writes, gallery } = recorder();
  const enricher = createEnricher({
    settings: fakeSettings({ imageServiceBaseUrl: "https://img.example" }),
    gallery,
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            "1": {
              success: true,
              data: { base64: encodeBase64(WEBP), contentType: "image/webp", nsfw: SCORES },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  });

  await enricher.enrich([row(1, { bytes: PNG, sourceBytes: PNG.byteLength })]);
  assertEquals(writes[0].input.thumb, null);
  assertEquals(writes[0].input.tag, "safe");
  assertEquals(writes[0].input.status, "ok");
});

Deno.test("enrich marks oversized sources failed without calling the service", async () => {
  const { writes, gallery } = recorder();
  let calls = 0;
  const enricher = createEnricher({
    settings: fakeSettings({ imageServiceBaseUrl: "https://img.example" }),
    gallery,
    maxSourceBytes: 10,
    fetchImpl: () => {
      calls++;
      return Promise.reject(new Error("should not be called"));
    },
  });

  const report = await enricher.enrich([
    row(1, { bytes: new Uint8Array(11), sourceBytes: 11 }),
  ]);
  assertEquals(calls, 0);
  assertEquals(report, { processed: 1, succeeded: 0, failed: 1 });
  assertEquals(writes[0].input.status, "failed");
  assertEquals(writes[0].input.error, "source exceeds 50 MiB");
});

Deno.test("enrich marks the chunk failed on network errors and non-2xx responses", async () => {
  const rejected: EnrichReport[] = [];
  {
    const { writes, gallery } = recorder();
    const enricher = createEnricher({
      settings: fakeSettings({ imageServiceBaseUrl: "https://img.example" }),
      gallery,
      fetchImpl: () => Promise.reject(new Error("network down")),
    });
    rejected.push(await enricher.enrich([row(1), row(2)]));
    assertEquals(writes.length, 2);
    assertEquals(writes.every((write) => write.input.status === "failed"), true);
    assertEquals(writes[0].input.error, "network down");
  }
  assertEquals(rejected[0], { processed: 2, succeeded: 0, failed: 2 });

  const { writes, gallery } = recorder();
  const enricher = createEnricher({
    settings: fakeSettings({ imageServiceBaseUrl: "https://img.example" }),
    gallery,
    fetchImpl: () => Promise.resolve(new Response("boom", { status: 500 })),
  });
  const report = await enricher.enrich([row(1)]);
  assertEquals(report, { processed: 1, succeeded: 0, failed: 1 });
  assertEquals(writes[0].input.error, "image service responded 500");
});

Deno.test("url rows are sent as url and do not count against the byte budget", async () => {
  let body: unknown = null;
  const { writes, gallery } = recorder();
  const big = new Uint8Array(20 * 1024 * 1024);
  const enricher = createEnricher({
    settings: fakeSettings({ imageServiceBaseUrl: "https://img.example" }),
    gallery,
    fetchImpl: ((_input, init) => {
      body = JSON.parse(String(init?.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            "1": {
              success: true,
              data: { base64: encodeBase64(WEBP), contentType: "image/webp", nsfw: SCORES },
            },
            "2": {
              success: true,
              data: { base64: encodeBase64(WEBP), contentType: "image/webp", nsfw: SCORES },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch,
  });

  await enricher.enrich([
    row(1, { url: "https://agnes.example/1.png", bytes: big, sourceBytes: big.byteLength }),
    row(2, { url: "https://agnes.example/2.png", bytes: big, sourceBytes: big.byteLength }),
  ]);

  const items = body as { uuid: string; url?: string; base64?: string }[];
  assertEquals(items.length, 2);
  assertEquals(items.map((item) => item.uuid), ["1", "2"]);
  assertEquals(items.every((item) => item.url && item.base64 === undefined), true);
  assertEquals(writes[0].input.status, "ok");
});

Deno.test("a url-only row accepts the returned thumbnail", async () => {
  const { writes, gallery } = recorder();
  const enricher = createEnricher({
    settings: fakeSettings({ imageServiceBaseUrl: "https://img.example" }),
    gallery,
    fetchImpl: (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            "1": {
              success: true,
              data: { base64: encodeBase64(WEBP), contentType: "image/webp", nsfw: SCORES },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as typeof fetch,
  });

  await enricher.enrich([
    row(1, { url: "https://agnes.example/1.png", bytes: null, sourceBytes: 0 }),
  ]);
  assertEquals(writes[0].input.thumb, WEBP);
  assertEquals(writes[0].input.status, "ok");
});

Deno.test("retries a failed url item once with base64", async () => {
  const bodies: unknown[] = [];
  const { writes, gallery } = recorder();
  const enricher = createEnricher({
    settings: fakeSettings({ imageServiceBaseUrl: "https://img.example" }),
    gallery,
    fetchImpl: ((_input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const urlItem = Array.isArray(body) && body.some((item) => item.url);
      const payload: Record<string, unknown> = urlItem
        ? { "1": { success: false, error: "url host is not allowed" } }
        : {
          "1": {
            success: true,
            data: { base64: encodeBase64(WEBP), contentType: "image/webp", nsfw: SCORES },
          },
        };
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch,
  });

  const report = await enricher.enrich([
    row(1, { url: "https://agnes.example/1.png", bytes: SOURCE, sourceBytes: SOURCE.byteLength }),
  ]);

  assertEquals(bodies.length, 2);
  assertEquals((bodies[0] as { url?: string }[])[0].url, "https://agnes.example/1.png");
  assertEquals(
    (bodies[1] as { base64?: string }[])[0].base64 !== undefined,
    true,
  );
  assertEquals(report, { processed: 1, succeeded: 1, failed: 0 });
  assertEquals(writes[0].input.status, "ok");
});

Deno.test("does not retry url rows when the whole batch request fails", async () => {
  let calls = 0;
  const { writes, gallery } = recorder();
  const enricher = createEnricher({
    settings: fakeSettings({ imageServiceBaseUrl: "https://img.example" }),
    gallery,
    fetchImpl: (() => {
      calls++;
      return Promise.reject(new Error("network down"));
    }) as typeof fetch,
  });

  const report = await enricher.enrich([
    row(1, { url: "https://agnes.example/1.png", bytes: SOURCE, sourceBytes: SOURCE.byteLength }),
  ]);

  assertEquals(calls, 1);
  assertEquals(report, { processed: 1, succeeded: 0, failed: 1 });
  assertEquals(writes[0].input.error, "network down");
});

Deno.test("does not retry with base64 when the local copy exceeds the limit", async () => {
  let calls = 0;
  const { writes, gallery } = recorder();
  const enricher = createEnricher({
    settings: fakeSettings({ imageServiceBaseUrl: "https://img.example" }),
    gallery,
    maxSourceBytes: 10,
    fetchImpl: (() => {
      calls++;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            "1": { success: false, error: "url failed" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch,
  });

  const report = await enricher.enrich([
    row(1, {
      url: "https://agnes.example/1.png",
      bytes: new Uint8Array(11),
      sourceBytes: 11,
    }),
  ]);
  assertEquals(calls, 1);
  assertEquals(report, { processed: 1, succeeded: 0, failed: 1 });
  assertEquals(writes[0].input.error, "url failed");
});

Deno.test("re-chunks the retry set by item and byte budgets", async () => {
  let calls = 0;
  const { gallery } = recorder();
  const enricher = createEnricher({
    settings: fakeSettings({ imageServiceBaseUrl: "https://img.example" }),
    gallery,
    fetchImpl: (() => {
      calls++;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            "1": { success: false, error: "url failed" },
            "2": { success: false, error: "url failed" },
            "3": { success: false, error: "url failed" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch,
  });

  const big = new Uint8Array(20 * 1024 * 1024);
  await enricher.enrich([
    row(1, { url: "https://a/1.png", bytes: big, sourceBytes: big.byteLength }),
    row(2, { url: "https://a/2.png", bytes: big, sourceBytes: big.byteLength }),
    row(3, { url: "https://a/3.png", bytes: big, sourceBytes: big.byteLength }),
  ]);
  // 1 first pass + 3 retry chunks (20 MiB each; two would exceed 32 MiB).
  assertEquals(calls, 4);
});

Deno.test("enrich counts a failed database write as failed without throwing", async () => {
  const enricher = createEnricher({
    settings: fakeSettings({ imageServiceBaseUrl: "https://img.example" }),
    gallery: {
      setEnrichment: () => Promise.reject(new Error("db down")),
    },
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            "1": {
              success: true,
              data: { base64: encodeBase64(WEBP), contentType: "image/webp", nsfw: SCORES },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  });

  const report = await enricher.enrich([row(1)]);
  assertEquals(report, { processed: 1, succeeded: 0, failed: 1 });
});
