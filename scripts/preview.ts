import { decodeBase64 } from "@std/encoding/base64";
import { createAgnesClient } from "../lib/agnes.ts";
import type { NsfwScores } from "../lib/gallery.ts";
import { recordEnrichmentLog } from "../lib/logs.ts";
import { DEFAULT_SETTINGS } from "../lib/settings.ts";
import { createNodeSqliteExecutor } from "../lib/testing/node-sqlite-executor.ts";
import { buildHarness } from "./harness.ts";

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TINY_PNG = decodeBase64(TINY_PNG_B64);

const PROXY_KEY = "preview";

const sql = createNodeSqliteExecutor();
const harness = await buildHarness({
  apiKey: PROXY_KEY,
  sql,
  createClient: createAgnesClient,
});

const primary = await harness.store.create({
  name: "primary",
  apiKey: "agk_preview_primary_0001",
});
const backup = await harness.store.create({
  name: "backup",
  apiKey: "agk_preview_backup_0002",
});
await harness.store.recordFailure(backup.id, 15 * 60 * 1000);
await harness.settings.write({
  ...DEFAULT_SETTINGS,
  imageServiceBaseUrl: "http://localhost:8001/mock-image-service",
});

const models = ["agnes-image-2.5-flash", "agnes-image-2.1-flash"];
for (let i = 0; i < 20; i++) {
  const ok = i % 5 !== 0;
  const requested = i % 4 === 0 ? 3 : 1;
  const images = ok ? requested : 0;
  const ts = new Date(Date.now() - i * 7 * 60 * 1000).toISOString();
  await harness.logs.record({
    requestId: crypto.randomUUID(),
    ts,
    category: "request",
    stage: ok ? "complete" : "dispatch",
    endpoint: i % 3 === 0 ? "edits" : "generations",
    path: i % 3 === 0 ? "/v1/images/edits" : "/v1/images/generations",
    model: models[i % models.length],
    accountId: primary.id,
    accountName: primary.name,
    status: ok ? 200 : 429,
    ok,
    durationMs: 1200 + i * 37,
    requested,
    images,
    failed: requested - images,
    sizeRequest: "1K 1:1",
    sizeActual: ok ? "1024x1024" : null,
    errorCode: ok ? null : "rate_limit_exceeded",
    error: ok ? null : "upstream rate limited",
    attempts: [{
      index: 0,
      traces: [{
        accountId: primary.id,
        accountName: primary.name,
        status: ok ? 200 : 429,
        code: ok ? null : "rate_limit_exceeded",
        durationMs: 1200 + i * 37,
        message: ok ? null : "upstream rate limited",
      }],
    }],
  });
  await harness.modelUsage.record({
    model: models[i % models.length],
    day: ts.slice(0, 10),
    images,
    requested,
    failed: requested - images,
    at: ts,
  });
}

type PreviewTag = "safe" | "drawing" | "sexy" | "porn" | "hentai";

function nsfwScores(tag: PreviewTag): NsfwScores {
  const scores = { drawing: 0.03, hentai: 0.02, safe: 0.03, porn: 0.02, sexy: 0.02 };
  scores[tag] = 0.9;
  return {
    ...scores,
    isNsfw: tag === "sexy" || tag === "porn" || tag === "hentai",
  };
}

const prompts: { prompt: string; tag: PreviewTag | null; failed?: string }[] = [
  { prompt: "a red apple on a wooden table, soft studio light", tag: "safe" },
  { prompt: "海边日落，电影感色彩", tag: "drawing" },
  { prompt: "a small cabin in a snowy forest", tag: "sexy" },
  { prompt: "机械猫在霓虹街头，赛博朋克", tag: "porn" },
  { prompt: "watercolor flowers, minimal composition", tag: "hentai" },
  { prompt: "an astronaut riding a bicycle on the moon", tag: null },
  {
    prompt: "a lighthouse in a thunderstorm, long exposure",
    tag: null,
    failed: "image service item failed",
  },
  { prompt: "cozy reading nook, warm afternoon light", tag: "safe" },
];
for (let i = 0; i < prompts.length; i++) {
  const item = prompts[i];
  const ts = new Date(Date.now() - i * 40 * 60 * 1000).toISOString();
  const id = await harness.gallery.record({
    ts,
    endpoint: "generations",
    model: models[i % models.length],
    accountId: primary.id,
    accountName: primary.name,
    prompt: item.prompt,
    size: "1024x1024",
    tier: "1K",
    ratio: "1:1",
    mime: "image/png",
    bytes: TINY_PNG,
    sourceUrl: null,
  });
  if (item.tag) {
    await harness.gallery.setEnrichment(id, {
      thumb: TINY_PNG,
      thumbMime: "image/png",
      nsfw: nsfwScores(item.tag),
      tag: item.tag,
      status: "ok",
      error: null,
      at: ts,
    });
  } else if (item.failed) {
    await harness.gallery.setEnrichment(id, {
      thumb: null,
      thumbMime: null,
      nsfw: null,
      tag: null,
      status: "failed",
      error: item.failed,
      at: ts,
    });
  }
}

const enrichLogSeeds = [
  {
    offsetMin: 3,
    endpoint: "archive/enrich",
    path: null,
    requested: 1,
    succeeded: 1,
    failed: 0,
    durationMs: 940,
  },
  {
    offsetMin: 18,
    endpoint: "gallery/enrich",
    path: "/admin/api/gallery/enrich",
    requested: 12,
    succeeded: 10,
    failed: 2,
    durationMs: 8600,
  },
  {
    offsetMin: 45,
    endpoint: "archive/enrich",
    path: null,
    requested: 2,
    succeeded: 2,
    failed: 0,
    durationMs: 1580,
  },
  {
    offsetMin: 90,
    endpoint: "gallery/enrich",
    path: "/admin/api/gallery/enrich",
    requested: 8,
    succeeded: 0,
    failed: 8,
    durationMs: 30000,
  },
];
for (const seed of enrichLogSeeds) {
  await recordEnrichmentLog(harness.logs, {
    ts: new Date(Date.now() - seed.offsetMin * 60 * 1000).toISOString(),
    endpoint: seed.endpoint,
    path: seed.path,
    requested: seed.requested,
    succeeded: seed.succeeded,
    failed: seed.failed,
    durationMs: seed.durationMs,
  });
}

const port = 8001;
console.log(`Preview console on http://localhost:${port}/admin (key: ${PROXY_KEY})`);
console.log(`Auto-login: http://localhost:${port}/preview-shot`);
console.log("补齐按钮演示：第一次点击全部失败（按钮变红），再次点击成功（变绿），进行中为渐变。");

const mockFailures = new Set<string>();

Deno.serve({ port }, async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/mock-image-service/api/batch") {
    const parsed: unknown = await request.json();
    const items = Array.isArray(parsed) ? parsed as { uuid?: unknown }[] : [];
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const payload: Record<string, unknown> = {};
    for (const item of items) {
      const uuid = String(item.uuid ?? "");
      const params = (item as { params?: Record<string, unknown> }).params ?? {};
      if (params.format === "json") {
        payload[uuid] = {
          success: true,
          data: { width: 1024, height: 1024, format: "png", sourceContentType: "image/png" },
        };
        continue;
      }
      if (mockFailures.has(uuid)) {
        payload[uuid] = {
          success: true,
          data: {
            base64: TINY_PNG_B64,
            contentType: "image/png",
            nsfw: {
              drawing: 0.02,
              hentai: 0.01,
              safe: 0.93,
              porn: 0.02,
              sexy: 0.02,
              isNsfw: false,
            },
          },
        };
      } else {
        mockFailures.add(uuid);
        payload[uuid] = { success: false, error: "mock: first pass fails on purpose" };
      }
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.pathname === "/preview-shot") {
    const token = await harness.session.issue();
    const secure = url.protocol === "https:";
    const cookie = `agnes_session=${token}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=2592000` +
      (secure ? "; Secure" : "");
    return new Response(null, {
      status: 302,
      headers: { location: "/admin", "set-cookie": cookie },
    });
  }
  return await harness.handler(request);
});
