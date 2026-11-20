import { createAgnesClient } from "../lib/agnes.ts";
import { createNodeSqliteExecutor } from "../lib/testing/node-sqlite-executor.ts";
import { buildHarness } from "./harness.ts";

const upstreamKey = Deno.env.get("SMOKE_AGNES_API_KEY");
if (!upstreamKey) {
  console.log("Usage: SMOKE_AGNES_API_KEY=<agnes key> deno task smoke");
  console.log("Optional: SMOKE_MODEL (default agnes-image-2.5-flash)");
  Deno.exit(0);
}

const PROXY_KEY = "smoke";
const model = Deno.env.get("SMOKE_MODEL") ?? "agnes-image-2.5-flash";

const sql = createNodeSqliteExecutor();
const harness = await buildHarness({
  apiKey: PROXY_KEY,
  sql,
  createClient: createAgnesClient,
});
await harness.store.create({ name: "smoke", apiKey: upstreamKey });

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  Deno.exit(1);
}

function auth(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { authorization: `Bearer ${PROXY_KEY}`, ...(init.headers ?? {}) },
  };
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return await harness.handler(new Request(`https://smoke.local${path}`, auth(init)));
}

console.log("1/5 /v1/models");
const modelsResponse = await call("/v1/models");
if (modelsResponse.status !== 200) fail(`models returned ${modelsResponse.status}`);
const modelsBody = await modelsResponse.json();
if (!Array.isArray(modelsBody.data) || modelsBody.data.length === 0) fail("empty model list");

console.log(`2/5 generations (${model}, 1K)`);
const generation = await call("/v1/images/generations", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, prompt: "a red apple on a white table", size: "1024x1024", n: 1 }),
});
const generationBody = await generation.json();
if (generation.status !== 200) {
  fail(`generation returned ${generation.status}: ${JSON.stringify(generationBody)}`);
}
const first = generationBody.data?.[0];
if (!first) fail("generation returned no images");
const reference = first.b64_json ? `data:image/png;base64,${first.b64_json}` : first.url;
if (!reference) fail("generation image has neither b64_json nor url");

console.log("3/5 edits (JSON reference image)");
const edit = await call("/v1/images/edits", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model,
    prompt: "turn the apple blue",
    size: "1024x1024",
    images: [{ image_url: reference }],
  }),
});
const editBody = await edit.json();
if (edit.status !== 200) fail(`edits returned ${edit.status}: ${JSON.stringify(editBody)}`);

console.log("4/5 gallery has at least two rows");
const gallery = await call("/admin/api/gallery?limit=10");
const galleryBody = await gallery.json();
if (!Array.isArray(galleryBody.items) || galleryBody.items.length < 2) {
  fail(`gallery has ${galleryBody.items?.length ?? 0} rows`);
}

console.log("5/5 delete one gallery row");
const target = galleryBody.items[0];
const removed = await call(`/admin/api/gallery/${target.id}`, { method: "DELETE" });
if (removed.status !== 204) fail(`delete returned ${removed.status}`);

console.log("OK smoke passed");
sql.close();
