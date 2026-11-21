import { assert, assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { ApiError } from "../../lib/errors.ts";
import { createAccountStore, ensureSchema } from "../../lib/accounts.ts";
import { createSessionSigner } from "../../lib/auth.ts";
import { createHandler, type HandlerOptions } from "../../lib/app.ts";
import { createSettingsStore } from "../../lib/settings.ts";
import { createRequestLogStore } from "../../lib/logs.ts";
import { createModelUsageStore } from "../../lib/model-usage.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";
import type { AgnesGateway, AgnesRequest } from "../../lib/pool.ts";
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
  const session = createSessionSigner(API_KEY);
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
  assertEquals((await store.get(account.id))?.imageCount, 1);
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

Deno.test("image_param_mode auto retries edits at the top level and caches it", async () => {
  let clock = new Date("2026-11-20T10:00:00Z");
  let failNext = true;
  const { sql, call, calls } = await setup(() => {
    if (failNext) {
      failNext = false;
      return Promise.reject(new ApiError(400, "nested image rejected", "invalid_request_error"));
    }
    return Promise.resolve({ created: 1, data: [{ b64_json: TINY_B64 }] });
  }, { now: () => clock });

  const editBody = {
    model: "m",
    prompt: "p",
    size: "1K",
    images: ["https://example.com/a.png"],
  };
  const first = await postJson(call, "/v1/images/edits", editBody);
  assertEquals(first.status, 200);
  assertEquals(calls.length, 2);
  const nested = calls[0].request.body as Record<string, unknown>;
  assertEquals((nested.extra_body as Record<string, unknown>).image, ["https://example.com/a.png"]);
  assertEquals(nested.image, undefined);
  const topLevel = calls[1].request.body as Record<string, unknown>;
  assertEquals(topLevel.image, ["https://example.com/a.png"]);
  assertEquals((topLevel.extra_body as Record<string, unknown>).image, undefined);

  // The cached top_level mode is used first for the next edit request.
  const second = await postJson(call, "/v1/images/edits", editBody);
  assertEquals(second.status, 200);
  assertEquals(calls.length, 3);
  const cached = calls[2].request.body as Record<string, unknown>;
  assertEquals(cached.image, ["https://example.com/a.png"]);

  // After ten minutes the cache expires and nested is preferred again.
  clock = new Date(clock.getTime() + 10 * 60 * 1000 + 1);
  const third = await postJson(call, "/v1/images/edits", editBody);
  assertEquals(third.status, 200);
  const expired = calls[3].request.body as Record<string, unknown>;
  assertEquals(expired.image, undefined);
  assert((expired.extra_body as Record<string, unknown>).image !== undefined);
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

Deno.test("unknown errors during generation are swallowed into 500s", async () => {
  const { sql, call } = await setup(() => Promise.reject(new Error("boom")));
  const response = await postJson(call, "/v1/images/generations", {
    model: "m",
    prompt: "p",
    size: "1024x1024",
  });
  assertEquals(response.status, 500);
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
  assertEquals(rows[0].size, "900x1200");
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
  assertEquals((await response.json()).size, "864x1152");
  assert(response.headers.get("x-agnes-warnings")?.includes("size-measure-failed"));
  const rows = await logs.list(10);
  assertEquals(rows[0].size, null);
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
  assertEquals((await logs.list(10))[0].size, "900x1200,1024x1024");
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
  assertEquals((await logs.list(10))[0].size, "2K 16:9");
  sql.close();
});
