import { decodeBase64 } from "@std/encoding/base64";
import { createAgnesClient } from "../lib/agnes.ts";
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

const models = ["agnes-image-2.5-flash", "agnes-image-2.1-flash"];
for (let i = 0; i < 20; i++) {
  const ok = i % 5 !== 0;
  const requested = i % 4 === 0 ? 3 : 1;
  const images = ok ? requested : 0;
  const ts = new Date(Date.now() - i * 7 * 60 * 1000).toISOString();
  await harness.logs.record({
    requestId: crypto.randomUUID(),
    ts,
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

const prompts = [
  "a red apple on a wooden table, soft studio light",
  "海边日落，电影感色彩",
  "a small cabin in a snowy forest",
  "机械猫在霓虹街头，赛博朋克",
  "watercolor flowers, minimal composition",
  "an astronaut riding a bicycle on the moon",
];
for (let i = 0; i < prompts.length; i++) {
  await harness.gallery.record({
    ts: new Date(Date.now() - i * 40 * 60 * 1000).toISOString(),
    endpoint: "generations",
    model: models[i % models.length],
    accountId: primary.id,
    accountName: primary.name,
    prompt: prompts[i],
    size: "1024x1024",
    tier: "1K",
    ratio: "1:1",
    mime: "image/png",
    bytes: TINY_PNG,
    sourceUrl: null,
  });
}

const port = 8001;
console.log(`Preview console on http://localhost:${port}/admin (key: ${PROXY_KEY})`);
console.log(`Auto-login: http://localhost:${port}/preview-shot`);

Deno.serve({ port }, async (request) => {
  const url = new URL(request.url);
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
