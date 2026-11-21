import { assert, assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { ApiError } from "../../lib/errors.ts";
import { createAccountStore, ensureSchema } from "../../lib/accounts.ts";
import { createAuthStateStore, createSessionService } from "../../lib/auth.ts";
import { createHandler, type HandlerOptions } from "../../lib/app.ts";
import { createSettingsStore } from "../../lib/settings.ts";
import { createRequestLogStore } from "../../lib/logs.ts";
import { createModelUsageStore } from "../../lib/model-usage.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";
import type { AgnesGateway, AgnesRequest } from "../../lib/pool.ts";
import { createAccountPool } from "../../lib/pool.ts";
import type { ArchiveRequest } from "../../lib/archive.ts";

const API_KEY = "proxy-key";

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function pngB64(width: number, height: number): string {
  return encodeBase64(pngHeader(width, height));
}

const TINY_B64 = pngB64(1024, 1024);

interface GatewayCall {
  baseUrl: string;
  options?: { timeoutMs?: number; maxAttempts?: number };
  request: AgnesRequest;
}

function createFakePool(handler: (call: GatewayCall, index: number) => Promise<unknown>) {
  const calls: GatewayCall[] = [];
  return {
    calls,
    pool: {
      gateway(
        baseUrl: string,
        _hooks: unknown,
        options?: { timeoutMs?: number; maxAttempts?: number },
      ) {
        const gateway: AgnesGateway = {
          generate: async (request) => {
            const call: GatewayCall = { baseUrl, options, request };
            calls.push(call);
            const body = await handler(call, calls.length - 1);
            return { status: 200, body, account: { id: 1, name: "main" } };
          },
        };
        return gateway;
      },
    },
  };
}

async function setup(
  handler: (call: GatewayCall, index: number) => Promise<unknown>,
  overrides: Partial<HandlerOptions> = {},
) {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  const store = createAccountStore(sql);
  const account = await store.create({ name: "main", apiKey: "upstream-key" });
  const { pool, calls } = createFakePool(handler);
  const logs = createRequestLogStore(sql);
  const modelUsage = createModelUsageStore(sql);
  const archives: ArchiveRequest[] = [];
  const settings = createSettingsStore(sql);
  const session = createSessionService(API_KEY, createAuthStateStore(sql));
  const admin = {
    matches: (path: string) => path.startsWith("/admin/api/"),
    handle: () => Promise.resolve(new Response("admin")),
  };

  const options: HandlerOptions = {
    pool: pool as HandlerOptions["pool"],
    store,
    settings,
    admin,
    logs,
    modelUsage,
    archiver: {
      archive: (request) => {
        archives.push(request);
        return Promise.resolve();
      },
    },
    apiKey: API_KEY,
    session,
    renderAdminPage: () => "<html>console</html>",
    renderLoginPage: () => "<html>login</html>",
    ...overrides,
  };
  const handlerFn = createHandler(options);

  const call = (path: string, init: RequestInit = {}) =>
    handlerFn(
      new Request(`https://proxy.test${path}`, {
        ...init,
        headers: { authorization: `Bearer ${API_KEY}`, ...(init.headers ?? {}) },
      }),
    );

  return { sql, store, account, logs, modelUsage, archives, calls, call, handlerFn, session };
}

type Call = (path: string, init?: RequestInit) => Promise<Response>;

function postJson(call: Call, path: string, body: unknown) {
  return call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("data plane requires a Bearer key and rejects cookies", async () => {
  const { sql, handlerFn, session } = await setup(() =>
    Promise.resolve({ created: 1, data: [{ b64_json: TINY_B64 }] })
  );

  const noAuth = await handlerFn(
    new Request("https://proxy.test/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "m", prompt: "p" }),
    }),
  );
  assertEquals(noAuth.status, 401);
  assertEquals((await noAuth.json()).error.type, "invalid_request_error");

  const wrong = await handlerFn(
    new Request("https://proxy.test/v1/images/generations", {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: JSON.stringify({ model: "m", prompt: "p" }),
    }),
  );
  assertEquals(wrong.status, 401);

  const token = await session.issue();
  const cookieOnly = await handlerFn(
    new Request("https://proxy.test/v1/images/generations", {
      method: "POST",
      headers: { cookie: `agnes_session=${token}` },
      body: JSON.stringify({ model: "m", prompt: "p" }),
    }),
  );
  assertEquals(cookieOnly.status, 401);
  sql.close();
});

Deno.test("models, health, root redirect and unknown paths", async () => {
  const { sql, call, handlerFn } = await setup(() => Promise.resolve({}));

  const models = await call("/v1/models");
  assertEquals(models.status, 200);
  const body = await models.json();
  assertEquals(body.data.map((model: { id: string }) => model.id), [
    "agnes-image-2.5-flash",
    "agnes-image-2.1-flash",
  ]);

  assertEquals((await call("/health")).status, 200);
  const root = await handlerFn(new Request("https://proxy.test/"));
  assertEquals(root.status, 302);
  assertEquals(root.headers.get("location"), "/admin");
  assertEquals((await call("/v1/unknown")).status, 404);
  sql.close();
});

Deno.test("the edits alias routes to the edit handler", async () => {
  const { sql, call, calls } = await setup(() =>
    Promise.resolve({ created: 1, data: [{ b64_json: TINY_B64 }] })
  );
  const form = new FormData();
  form.set("model", "m");
  form.set("prompt", "p");
  form.set("size", "1K");
  form.set(
    "image",
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png", {
      type: "image/png",
    }),
  );
  const ok = await call("/v1/images/edit", { method: "POST", body: form });
  assertEquals(ok.status, 200);
  assertEquals(calls.length, 1);
  assertEquals((calls[0].request.body as Record<string, unknown>).size, "1K");
  sql.close();
});

Deno.test("stream is rejected with unsupported_parameter", async () => {
  const { sql, call } = await setup(() => Promise.resolve({}));
  const response = await postJson(call, "/v1/images/generations", {
    model: "m",
    prompt: "p",
    stream: true,
  });
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error.param, "stream");
  assertEquals(body.error.code, "unsupported_parameter");
  sql.close();
});

Deno.test("a generation request is translated, logged and archived", async () => {
  const { sql, call, calls, logs, store, account, archives } = await setup(() =>
    Promise.resolve({ created: 1, data: [{ b64_json: TINY_B64 }] })
  );

  const response = await postJson(call, "/v1/images/generations", {
    model: "agnes-image-2.5-flash",
    prompt: "x",
    size: "1024x1024",
  });
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.data[0].b64_json, TINY_B64);
  assertEquals(body.size, "1024x1024");
  assertEquals(body.output_format, "png");
  assertEquals(response.headers.get("x-agnes-resolved-size"), "1K 1:1");

  assertEquals(calls[0].request.body, {
    model: "agnes-image-2.5-flash",
    prompt: "x",
    size: "1K",
    ratio: "1:1",
    return_base64: true,
  });
  assertEquals(calls[0].options, { timeoutMs: 300000, maxAttempts: 3 });

  const log = (await logs.list(1))[0];
  assertEquals(log.requested, 1);
  assertEquals(log.images, 1);
  assertEquals(log.failed, 0);
  assertEquals(log.ok, true);
  assertEquals((await store.get(account.id))?.upstreamImages, 1);
  assertEquals(archives.length, 1);
  assertEquals(archives[0].prompt, "x");
  assertEquals(archives[0].model, "agnes-image-2.5-flash");
  sql.close();
});

Deno.test("n fans out without a 10 image cap", async () => {
  const { sql, call, calls } = await setup(() =>
    Promise.resolve({ created: 1, data: [{ b64_json: TINY_B64 }] })
  );
  const response = await postJson(call, "/v1/images/generations", {
    model: "m",
    prompt: "p",
    size: "1024x1024",
    n: 25,
  });
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.data.length, 25);
  assertEquals(calls.length, 25);
  sql.close();
});

Deno.test("warnings from ignored fields surface in the header", async () => {
  const { sql, call } = await setup(() =>
    Promise.resolve({ created: 1, data: [{ b64_json: TINY_B64 }] })
  );
  const response = await postJson(call, "/v1/images/generations", {
    model: "m",
    prompt: "p",
    quality: "high",
    background: "opaque",
  });
  assertEquals(response.status, 200);
  const warnings = response.headers.get("x-agnes-warnings") ?? "";
  assert(warnings.includes("quality"));
  assert(warnings.includes("background"));
  sql.close();
});

Deno.test("partial failures return 200 with only the successful images", async () => {
  const { sql, call, logs, archives } = await setup((_call, index) => {
    if (index === 1) return Promise.reject(new ApiError(429, "rate limited", "rate_limit_error"));
    if (index === 2) return Promise.reject(new ApiError(400, "bad", "invalid_request_error"));
    return Promise.resolve({ created: 1, data: [{ b64_json: TINY_B64 }] });
  });
  const response = await postJson(call, "/v1/images/generations", {
    model: "m",
    prompt: "p",
    size: "1024x1024",
    n: 5,
  });
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.data.length, 3);
  assertEquals(response.headers.get("x-agnes-requested"), "5");
  assertEquals(response.headers.get("x-agnes-succeeded"), "3");
  assertEquals(response.headers.get("x-agnes-failed"), "2");
  const statuses = response.headers.get("x-agnes-failure-statuses") ?? "";
  assert(statuses.includes("429"));
  assert(statuses.includes("400"));
  assert((response.headers.get("x-agnes-warnings") ?? "").includes("partial-success"));

  const log = (await logs.list(1))[0];
  assertEquals(log.requested, 5);
  assertEquals(log.images, 3);
  assertEquals(log.failed, 2);
  assertEquals(log.ok, false);
  assertEquals(archives.length, 3);
  sql.close();
});

Deno.test("total failure returns the first subrequest error", async () => {
  const { sql, call, logs } = await setup(() =>
    Promise.reject(new ApiError(429, "rate limited", "rate_limit_error"))
  );
  const response = await postJson(call, "/v1/images/generations", {
    model: "m",
    prompt: "p",
    size: "1024x1024",
    n: 5,
  });
  assertEquals(response.status, 429);
  const body = await response.json();
  assertEquals(body.error.message, "rate limited");

  const log = (await logs.list(1))[0];
  assertEquals(log.requested, 5);
  assertEquals(log.images, 0);
  assertEquals(log.failed, 5);
  assertEquals(log.ok, false);
  sql.close();
});

Deno.test("an upstream 400 is not retried with the other image placement", async () => {
  const { sql, calls, call } = await setup(() =>
    Promise.reject(new ApiError(400, "bad prompt", "invalid_request_error"))
  );
  const response = await postJson(call, "/v1/images/edits", {
    model: "agnes-image-2.5-flash",
    prompt: "x",
    size: "1K",
    images: ["https://a.example/x.png"],
  });
  assertEquals(response.status, 400);
  assertEquals(calls.length, 1);
  sql.close();
});

Deno.test("a 429 subrequest failure wins over a 502", async () => {
  const { sql, call } = await setup((_call, index) =>
    index === 0
      ? Promise.reject(new ApiError(502, "upstream exploded"))
      : Promise.reject(new ApiError(429, "rate limited", "rate_limit_error"))
  );
  const response = await postJson(call, "/v1/images/generations", {
    model: "m",
    prompt: "p",
    size: "1K",
    n: 2,
  });
  assertEquals(response.status, 429);
  assertEquals((await response.json()).error.code, "rate_limit_exceeded");
  sql.close();
});

Deno.test("no_available_accounts wins the 503 tie", async () => {
  const { sql, call } = await setup((_call, index) =>
    index === 0
      ? Promise.reject(
        new ApiError(503, "no accounts", "server_error", null, "no_available_accounts"),
      )
      : Promise.reject(
        new ApiError(503, "upstream down", "server_error", null, "upstream_unavailable"),
      )
  );
  const response = await postJson(call, "/v1/images/generations", {
    model: "m",
    prompt: "p",
    size: "1K",
    n: 2,
  });
  assertEquals(response.status, 503);
  assertEquals((await response.json()).error.code, "no_available_accounts");
  sql.close();
});

Deno.test("one empty subrequest among n becomes a partial failure", async () => {
  const { sql, call } = await setup((_call, index) =>
    Promise.resolve(
      index === 0
        ? { created: 1, data: [{}] }
        : { created: 1, data: [{ b64_json: pngB64(10, 10) }] },
    )
  );
  const response = await postJson(call, "/v1/images/generations", {
    model: "agnes-image-2.5-flash",
    prompt: "x",
    n: 2,
    size: "1K",
  });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("x-agnes-succeeded"), "1");
  assertEquals(response.headers.get("x-agnes-failed"), "1");
  assertEquals((await response.json()).data.length, 1);
  sql.close();
});

Deno.test("a parse failure is logged without touching model usage", async () => {
  const { sql, logs, modelUsage, call } = await setup(() =>
    Promise.resolve({ created: 1, data: [{ b64_json: TINY_B64 }] })
  );
  const response = await postJson(call, "/v1/images/generations", {
    model: "agnes-image-2.5-flash",
    prompt: "",
  });
  assertEquals(response.status, 400);
  assert(response.headers.get("x-request-id"));
  const row = (await logs.list())[0];
  assertEquals(row.stage, "parse");
  assertEquals(row.requested, null);
  assertEquals(row.model, null);
  assertEquals(row.errorCode, "missing_parameter");
  assertEquals((await modelUsage.byDay(new Date().toISOString().slice(0, 10))).size, 0);
  sql.close();
});

Deno.test("an unauthenticated 401 is not written to the request log", async () => {
  const { sql, logs, handlerFn } = await setup(() =>
    Promise.resolve({ created: 1, data: [{ b64_json: TINY_B64 }] })
  );
  const response = await handlerFn(
    new Request("https://proxy.test/v1/images/generations", { method: "POST" }),
  );
  assertEquals(response.status, 401);
  assert(response.headers.get("x-request-id"));
  assertEquals(await logs.count(), 0);
  sql.close();
});

Deno.test("partial success logs partial_success and the first successful account", async () => {
  const { sql, logs, call } = await setup((_call, index) =>
    index === 0
      ? Promise.reject(new ApiError(502, "upstream exploded"))
      : Promise.resolve({ created: 1, data: [{ b64_json: pngB64(10, 10) }] })
  );
  const response = await postJson(call, "/v1/images/generations", {
    model: "agnes-image-2.5-flash",
    prompt: "x",
    size: "1K",
    n: 2,
  });
  assertEquals(response.status, 200);
  const row = (await logs.list())[0];
  assertEquals(row.stage, "complete");
  assertEquals(row.errorCode, "partial_success");
  assertEquals(row.accountName, "main");
  assert((row.error ?? "").includes("upstream exploded"));
  sql.close();
});

Deno.test("attempts record each key tried per subrequest", async () => {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  const store = createAccountStore(sql);
  await store.create({ name: "a", apiKey: "key-a" });
  await store.create({ name: "b", apiKey: "key-b" });
  const pool = createAccountPool({
    store,
    createClient: ({ apiKey }) => ({
      generate: () => {
        if (apiKey === "key-a") {
          return Promise.reject(new ApiError(401, "bad key", "authentication_error"));
        }
        return Promise.resolve({
          status: 200,
          body: { created: 1, data: [{ b64_json: TINY_B64 }] },
        });
      },
    }),
  });
  const logs = createRequestLogStore(sql);
  const modelUsage = createModelUsageStore(sql);
  const handler = createHandler({
    pool,
    store,
    settings: createSettingsStore(sql),
    admin: {
      matches: () => false,
      handle: () => Promise.resolve(new Response(null, { status: 404 })),
    },
    logs,
    modelUsage,
    archiver: { archive: () => Promise.resolve() },
    apiKey: API_KEY,
    session: createSessionService(API_KEY, createAuthStateStore(sql)),
  });

  const response = await handler(
    new Request("https://proxy.test/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "x", size: "1K" }),
    }),
  );
  assertEquals(response.status, 200);
  const row = (await logs.list())[0];
  const attempts = row.attempts as {
    index: number;
    traces: { accountName: string; status: number }[];
  }[] | null;
  assertEquals(attempts?.length, 1);
  assertEquals(attempts?.[0].traces.map((trace) => trace.accountName), ["a", "b"]);
  assertEquals(attempts?.[0].traces.map((trace) => trace.status), [401, 200]);
  sql.close();
});

Deno.test("no available accounts logs a synthetic 503 trace", async () => {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  const store = createAccountStore(sql);
  const pool = createAccountPool({
    store,
    createClient: () => ({ generate: () => Promise.resolve({ status: 200, body: {} }) }),
  });
  const logs = createRequestLogStore(sql);
  const handler = createHandler({
    pool,
    store,
    settings: createSettingsStore(sql),
    admin: {
      matches: () => false,
      handle: () => Promise.resolve(new Response(null, { status: 404 })),
    },
    logs,
    modelUsage: createModelUsageStore(sql),
    archiver: { archive: () => Promise.resolve() },
    apiKey: API_KEY,
    session: createSessionService(API_KEY, createAuthStateStore(sql)),
  });

  const response = await handler(
    new Request("https://proxy.test/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "x", size: "1K" }),
    }),
  );
  assertEquals(response.status, 503);
  const row = (await logs.list())[0];
  assertEquals(row.stage, "dispatch");
  const attempts = row.attempts as
    | {
      index: number;
      traces: { accountId: number | null; status: number; code: string | null }[];
    }[]
    | null;
  assertEquals(attempts?.length, 1);
  assertEquals(attempts?.[0].traces.length, 1);
  assertEquals(attempts?.[0].traces[0].accountId, null);
  assertEquals(attempts?.[0].traces[0].status, 503);
  assertEquals(attempts?.[0].traces[0].code, "no_available_accounts");
  sql.close();
});

Deno.test("archive errors never break the response", async () => {
  const { sql, call } = await setup(
    () => Promise.resolve({ created: 1, data: [{ b64_json: TINY_B64 }] }),
    {
      archiver: {
        archive: () => Promise.reject(new Error("archive down")),
      },
    },
  );
  const response = await postJson(call, "/v1/images/generations", {
    model: "m",
    prompt: "p",
    size: "1024x1024",
  });
  assertEquals(response.status, 200);
  sql.close();
});

Deno.test("deep health checks the ready callback", async () => {
  let healthy = true;
  const { sql, call } = await setup(() => Promise.resolve({}), {
    readyCheck: () => healthy ? Promise.resolve() : Promise.reject(new Error("db down")),
  });
  assertEquals((await call("/health?deep=1")).status, 200);
  healthy = false;
  assertEquals((await call("/health?deep=1")).status, 503);
  sql.close();
});

Deno.test("admin pages use the session cookie", async () => {
  const { sql, handlerFn, session } = await setup(() => Promise.resolve({}));
  const anonymous = await handlerFn(new Request("https://proxy.test/admin"));
  assertEquals(anonymous.status, 200);
  assertEquals(await anonymous.text(), "<html>login</html>");

  const token = await session.issue();
  const authenticated = await handlerFn(
    new Request("https://proxy.test/admin", {
      headers: { cookie: `agnes_session=${token}` },
    }),
  );
  assertEquals(await authenticated.text(), "<html>console</html>");

  const apiResponse = await handlerFn(new Request("https://proxy.test/admin/api/accounts"));
  assertEquals(await apiResponse.text(), "admin");
  sql.close();
});

Deno.test("the admin HTML page does not slide the session", async () => {
  const issued = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-01-25T00:00:00Z");
  const { sql, handlerFn, session } = await setup(() => Promise.resolve({}), {
    now: () => now,
  });
  const token = await session.issue(issued);
  const response = await handlerFn(
    new Request("https://proxy.test/admin", {
      headers: { cookie: `agnes_session=${token}` },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("set-cookie"), null);
  sql.close();
});

Deno.test("an empty upstream body keeps invalid_upstream_response", async () => {
  const { sql, logs, call } = await setup(() => Promise.resolve({ created: 1, data: [] }));
  const response = await postJson(call, "/v1/images/generations", {
    model: "agnes-image-2.5-flash",
    prompt: "x",
    size: "1K",
  });
  assertEquals(response.status, 502);
  assertEquals((await response.json()).error.code, "invalid_upstream_response");
  const row = (await logs.list())[0];
  assertEquals(row.stage, "dispatch");
  assertEquals(row.errorCode, "invalid_upstream_response");
  sql.close();
});

Deno.test("the admin page reports a database failure instead of throwing", async () => {
  const { sql, handlerFn } = await setup(() => Promise.resolve({}), {
    session: {
      issue: () => Promise.resolve(""),
      verify: () =>
        Promise.reject(
          new ApiError(503, "database request timed out", "server_error", null, "database_timeout"),
        ),
      renew: () => Promise.resolve(null),
      revokeAll: () => Promise.resolve(1),
    },
  });
  const response = await handlerFn(
    new Request("https://proxy.test/admin", {
      headers: { cookie: "agnes_session=abc" },
    }),
  );
  assertEquals(response.status, 503);
  assertEquals((await response.json()).error.code, "database_timeout");
  sql.close();
});

Deno.test("unknown errors during generation become upstream 502s", async () => {
  const { sql, call } = await setup(() => Promise.reject(new Error("boom")));
  const response = await postJson(call, "/v1/images/generations", {
    model: "m",
    prompt: "p",
    size: "1024x1024",
  });
  assertEquals(response.status, 502);
  sql.close();
});

Deno.test("malformed JSON bodies are rejected", async () => {
  const { sql, call } = await setup(() => Promise.resolve({}));
  const response = await call("/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assertEquals(response.status, 400);
  sql.close();
});

Deno.test("response and log use the actual output size", async () => {
  const { sql, logs, call } = await setup(() =>
    Promise.resolve({ created: 1, data: [{ b64_json: pngB64(900, 1200) }] })
  );
  const reference = `data:image/png;base64,${pngB64(900, 1200)}`;
  const response = await postJson(call, "/v1/images/generations", {
    model: "agnes-image-2.5-flash",
    prompt: "x",
    images: [reference],
  });
  assertEquals(response.status, 200);
  assertEquals((await response.json()).size, "900x1200");
  assertEquals(response.headers.get("x-agnes-resolved-size"), "900x1200");
  const rows = await logs.list(10);
  assertEquals(rows[0].sizeActual, "900x1200");
  sql.close();
});

Deno.test("output_format follows the actual output bytes", async () => {
  const bytes = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x00,
    0x02,
    0x00,
    0x03,
  ]);
  const { sql, call } = await setup(
    () => Promise.resolve({ created: 1, data: [{ url: "https://out.example/a.jpg" }] }),
    { fetchImpl: () => Promise.resolve(new Response(bytes as unknown as BodyInit)) },
  );
  const response = await postJson(call, "/v1/images/generations", {
    model: "m",
    prompt: "p",
    size: "1K",
    response_format: "url",
  });
  assertEquals(response.status, 200);
  assertEquals((await response.json()).output_format, "jpeg");
  sql.close();
});

Deno.test("URL output measurement failure falls back to the expected size", async () => {
  const { sql, logs, call } = await setup(
    () => Promise.resolve({ created: 1, data: [{ url: "https://out.example/a.png" }] }),
    { fetchImpl: () => Promise.reject(new Error("boom")) },
  );
  const reference = `data:image/png;base64,${pngB64(900, 1200)}`;
  const response = await postJson(call, "/v1/images/generations", {
    model: "agnes-image-2.5-flash",
    prompt: "x",
    images: [reference],
  });
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.size, "864x1152");
  assertEquals("output_format" in body, false);
  assert(response.headers.get("x-agnes-warnings")?.includes("size-measure-failed"));
  const rows = await logs.list(10);
  assertEquals(rows[0].sizeActual, null);
  sql.close();
});

Deno.test("partial success with mixed sizes joins unique actual sizes in the log", async () => {
  const outputs = [[900, 1200], [1024, 1024]] as const;
  const { sql, logs, call } = await setup((_call, index) =>
    Promise.resolve({
      created: 1,
      data: [{ b64_json: pngB64(outputs[index][0], outputs[index][1]) }],
    })
  );
  const reference = `data:image/png;base64,${pngB64(900, 1200)}`;
  const response = await postJson(call, "/v1/images/generations", {
    model: "agnes-image-2.5-flash",
    prompt: "x",
    n: 2,
    images: [reference],
  });
  assertEquals(response.status, 200);
  assertEquals((await response.json()).size, "900x1200");
  assertEquals((await logs.list(10))[0].sizeActual, "900x1200,1024x1024");
  sql.close();
});

Deno.test("all failures log the request expression", async () => {
  const { sql, logs, call } = await setup(() => Promise.reject(new ApiError(400, "bad request")));
  const response = await postJson(call, "/v1/images/generations", {
    model: "agnes-image-2.5-flash",
    prompt: "x",
    size: "2K",
    ratio: "16:9",
    n: 2,
  });
  assertEquals(response.status, 400);
  assertEquals((await logs.list(10))[0].sizeRequest, "2K 16:9");
  sql.close();
});
