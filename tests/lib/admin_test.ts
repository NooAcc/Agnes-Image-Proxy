import { assertEquals, assertRejects } from "@std/assert";
import { ApiError } from "../../lib/errors.ts";
import { createAccountStore, ensureSchema, maskKey } from "../../lib/accounts.ts";
import { createAuthStateStore, createSessionService } from "../../lib/auth.ts";
import { createAdminApi, SESSION_COOKIE } from "../../lib/admin.ts";
import { createGalleryStore } from "../../lib/gallery.ts";
import { createRequestLogStore } from "../../lib/logs.ts";
import { createModelUsageStore } from "../../lib/model-usage.ts";
import { createSettingsStore } from "../../lib/settings.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";
import type { AgnesClient, AgnesClientFactory } from "../../lib/pool.ts";

const API_KEY = "proxy-key";

async function setup(clientFactory?: AgnesClientFactory, now?: () => Date) {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  const store = createAccountStore(sql);
  const settings = createSettingsStore(sql);
  const logs = createRequestLogStore(sql);
  const modelUsage = createModelUsageStore(sql);
  const gallery = createGalleryStore(sql);
  const authState = createAuthStateStore(sql);
  const session = createSessionService(API_KEY, authState);
  const clientCalls: { apiKey: string; body: unknown }[] = [];
  const createClient: AgnesClientFactory = clientFactory ?? (({ apiKey }) =>
    ({
      generate: (request) => {
        clientCalls.push({ apiKey, body: request.body });
        return Promise.resolve({
          status: 200,
          body: { created: 1, data: [{ url: "https://example.com/a.png" }] },
        });
      },
    }) as AgnesClient);

  const api = createAdminApi({
    store,
    settings,
    logs,
    modelUsage,
    gallery,
    apiKey: API_KEY,
    session,
    createClient,
    now,
  });

  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const request = new Request(`https://proxy.test${path}`, {
      ...init,
      headers: { authorization: `Bearer ${API_KEY}`, ...(init.headers ?? {}) },
    });
    return await api.handle(request, path.split("?")[0]);
  };

  const json = (path: string, method: string, body: unknown) =>
    call(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  return { sql, store, settings, logs, modelUsage, gallery, session, api, call, json, clientCalls };
}

Deno.test("session login sets an HttpOnly cookie and logout clears it", async () => {
  const { sql, api } = await setup();
  const login = await api.handle(
    new Request("https://proxy.test/admin/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: API_KEY }),
    }),
    "/admin/api/session",
  );
  assertEquals(login.status, 204);
  const cookie = login.headers.get("set-cookie") ?? "";
  assertEquals(cookie.includes(`${SESSION_COOKIE}=`), true);
  assertEquals(cookie.includes("HttpOnly"), true);
  assertEquals(cookie.includes("SameSite=Lax"), true);
  assertEquals(cookie.includes("Path=/admin"), true);
  assertEquals(cookie.includes("Max-Age="), true);
  assertEquals(cookie.includes("Secure"), true);

  const bad = await api.handle(
    new Request("https://proxy.test/admin/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "wrong" }),
    }),
    "/admin/api/session",
  );
  assertEquals(bad.status, 401);

  const logout = await api.handle(
    new Request("https://proxy.test/admin/api/session", { method: "DELETE" }),
    "/admin/api/session",
  );
  assertEquals(logout.status, 204);
  assertEquals((logout.headers.get("set-cookie") ?? "").includes("Max-Age=0"), true);

  const anonymous = await api.handle(
    new Request("https://proxy.test/admin/api/accounts"),
    "/admin/api/accounts",
  );
  assertEquals(anonymous.status, 401);
  sql.close();
});

Deno.test("session cookies authenticate the admin API", async () => {
  const { sql, api, session } = await setup();
  const token = await session.issue();
  const response = await api.handle(
    new Request("https://proxy.test/admin/api/accounts", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }),
    "/admin/api/accounts",
  );
  assertEquals(response.status, 200);
  sql.close();
});

Deno.test("account CRUD masks keys and rejects duplicates", async () => {
  const { sql, call, json } = await setup();
  const created = await json("/admin/api/accounts", "POST", {
    name: "main",
    apiKey: "agk_1234567890abcd",
  });
  assertEquals(created.status, 201);
  const body = await created.json();
  assertEquals(body.name, "main");
  assertEquals(body.apiKeyMasked, maskKey("agk_1234567890abcd"));
  assertEquals("apiKey" in body, false);

  const duplicate = await json("/admin/api/accounts", "POST", {
    name: "main",
    apiKey: "agk_other",
  });
  assertEquals(duplicate.status, 409);

  const list = await call("/admin/api/accounts");
  assertEquals((await list.json()).length, 1);

  const patched = await json(`/admin/api/accounts/${body.id}`, "PATCH", {
    name: "renamed",
    enabled: false,
  });
  assertEquals((await patched.json()).name, "renamed");

  const rotated = await json(`/admin/api/accounts/${body.id}`, "PATCH", {
    apiKey: "agk_ZZZZZZZZZZzzzz",
  });
  const rotatedBody = await rotated.json();
  assertEquals(rotatedBody.apiKeyMasked, maskKey("agk_ZZZZZZZZZZzzzz"));
  assertEquals(rotatedBody.name, "renamed");
  assertEquals("apiKey" in rotatedBody, false);

  const removed = await call(`/admin/api/accounts/${body.id}`, { method: "DELETE" });
  assertEquals(removed.status, 204);
  sql.close();
});

Deno.test("single-account test probes with the settings probe model", async () => {
  const { sql, store, json, clientCalls } = await setup();
  const account = await store.create({ name: "main", apiKey: "agk_1234567890abcd" });

  const response = await json(`/admin/api/accounts/${account.id}/test`, "POST", {});
  assertEquals(response.status, 200);
  assertEquals((await response.json()).ok, true);

  const body = clientCalls[0].body as Record<string, unknown>;
  assertEquals(body.model, "agnes-image-2.5-flash");
  assertEquals(body.size, "1K");
  assertEquals(body.ratio, "1:1");
  assertEquals(
    (body.extra_body as Record<string, unknown>).response_format,
    "url",
  );
  assertEquals((await store.get(account.id))?.status, "healthy");
  sql.close();
});

Deno.test("a failing account test marks the account degraded", async () => {
  const { sql, store, json } = await setup(() =>
    ({
      generate: () => Promise.reject(new ApiError(401, "bad key", "authentication_error")),
    }) as AgnesClient
  );
  const account = await store.create({ name: "main", apiKey: "agk_1234567890abcd" });
  const response = await json(`/admin/api/accounts/${account.id}/test`, "POST", {});
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.ok, false);
  assertEquals((await store.get(account.id))?.status, "degraded");
  sql.close();
});

Deno.test("a probe 400 does not degrade the account", async () => {
  const { sql, store, json } = await setup(() =>
    ({
      generate: () => Promise.reject(new ApiError(400, "bad model", "invalid_request_error")),
    }) as AgnesClient
  );
  const account = await store.create({ name: "a", apiKey: "k" });
  const response = await json(`/admin/api/accounts/${account.id}/test`, "POST", {});
  assertEquals(response.status, 200);
  const row = await store.get(account.id);
  assertEquals(row?.status, "healthy");
  assertEquals(row?.failCount, 0);
  sql.close();
});

Deno.test("a probe 2xx with an empty data array still marks the key healthy", async () => {
  const { sql, store, json } = await setup(() =>
    ({
      generate: () => Promise.resolve({ status: 200, body: { created: 1, data: [] } }),
    }) as AgnesClient
  );
  const account = await store.create({ name: "a", apiKey: "k" });
  await json(`/admin/api/accounts/${account.id}/test`, "POST", {});
  assertEquals((await store.get(account.id))?.status, "healthy");
  sql.close();
});

Deno.test("test-all probes every enabled account and import accepts name,key lines", async () => {
  const { sql, store, json } = await setup();
  await store.create({ name: "a", apiKey: "agk_aaaaaaaaaaaa" });
  await store.create({ name: "b", apiKey: "agk_bbbbbbbbbbbb" });
  await store.create({ name: "off", apiKey: "agk_cccccccccccc" });
  await store.update(3, { enabled: false });

  const all = await json("/admin/api/accounts/test", "POST", {});
  const results = await all.json();
  assertEquals(results.results.length, 2);

  const imported = await json("/admin/api/accounts/import", "POST", {
    text: "c,agk_1234567890cccc\n\nbad-line\nd,agk_1234567890dddd",
  });
  const importBody = await imported.json();
  assertEquals(importBody.results.length, 3);
  assertEquals(importBody.results[0].ok, true);
  assertEquals(importBody.results[1].ok, false);
  assertEquals((await store.list()).length, 5);
  sql.close();
});

Deno.test("settings round-trip and reject invalid values", async () => {
  const { sql, json } = await setup();
  const current = await (await json("/admin/api/settings", "GET", undefined)).json();
  assertEquals(current.defaultSize, "1K");

  const updated = await json("/admin/api/settings", "PUT", {
    ...current,
    probeConcurrency: 3,
  });
  assertEquals(updated.status, 200);
  assertEquals((await updated.json()).probeConcurrency, 3);

  const invalid = await json("/admin/api/settings", "PUT", {
    ...current,
    probeConcurrency: 0,
  });
  assertEquals(invalid.status, 400);
  sql.close();
});

Deno.test("logs list and clear", async () => {
  const { sql, logs, call } = await setup();
  for (let i = 0; i < 3; i++) {
    await logs.record({
      requestId: `req-${i}`,
      ts: `2026-11-20T10:00:0${i}.000Z`,
      stage: "complete",
      endpoint: "generations",
      path: "/v1/images/generations",
      model: "m",
      accountId: 1,
      accountName: "main",
      status: 200,
      ok: true,
      durationMs: 10,
      requested: 1,
      images: 1,
      failed: 0,
      sizeRequest: "1K 1:1",
      sizeActual: "1024x1024",
      errorCode: null,
      error: null,
      attempts: [],
    });
  }
  const listed = await call("/admin/api/logs");
  assertEquals((await listed.json()).length, 3);
  assertEquals((await call("/admin/api/logs", { method: "DELETE" })).status, 204);
  assertEquals((await (await call("/admin/api/logs")).json()).length, 0);
  sql.close();
});

Deno.test("overview merges the catalog with usage", async () => {
  const { sql, modelUsage, call } = await setup();
  await modelUsage.record({
    model: "agnes-image-2.5-flash",
    day: "2026-11-20",
    images: 2,
    requested: 2,
    failed: 0,
    at: "2026-11-20T10:00:00.000Z",
  });

  const response = await call("/admin/api/overview?day=2026-11-20");
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.totals, {
    requests: 1,
    successes: 1,
    partials: 0,
    failures: 0,
    images: 2,
  });
  assertEquals(body.models.length, 2);
  const flash = body.models.find((model: { id: string }) => model.id === "agnes-image-2.5-flash");
  assertEquals(flash.requests, 1);
  assertEquals(flash.successes, 1);
  assertEquals(flash.partials, 0);
  assertEquals(flash.failures, 0);
  assertEquals(flash.images, 2);
  const unused = body.models.find((model: { id: string }) => model.id === "agnes-image-2.1-flash");
  assertEquals(unused.requests, 0);
  assertEquals(body.settings.defaultSize, "1K");
  assertEquals(typeof body.accounts.total, "number");
  assertEquals(body.trend.length, 14);
  assertEquals(body.trend[13].day, "2026-11-20");
  assertEquals(body.trend[13].requests, 1);
  assertEquals(body.trend[13].successes, 1);
  assertEquals(body.trend[13].partials, 0);
  assertEquals(body.trend[13].failures, 0);
  assertEquals(body.trend[13].images, 2);
  assertEquals(body.trend[0].day, "2026-11-07");
  assertEquals(body.trend[0].requests, 0);

  const invalid = await call("/admin/api/overview?day=2026-13-40");
  assertEquals(invalid.status, 400);
  sql.close();
});

Deno.test("revoking the session invalidates every cookie", async () => {
  const { sql, api, session } = await setup();
  const token = await session.issue();
  const cookie = `${SESSION_COOKIE}=${token}`;
  const before = await api.handle(
    new Request("https://proxy.test/admin/api/accounts", { headers: { cookie } }),
    "/admin/api/accounts",
  );
  assertEquals(before.status, 200);

  const revoke = await api.handle(
    new Request("https://proxy.test/admin/api/session/revoke", {
      method: "POST",
      headers: { cookie },
    }),
    "/admin/api/session/revoke",
  );
  assertEquals(revoke.status, 204);
  assertEquals((revoke.headers.get("set-cookie") ?? "").includes("Max-Age=0"), true);

  const after = await api.handle(
    new Request("https://proxy.test/admin/api/accounts", { headers: { cookie } }),
    "/admin/api/accounts",
  );
  assertEquals(after.status, 401);
  sql.close();
});

Deno.test("login failures are rate limited for every client", async () => {
  let clock = new Date("2026-01-01T00:00:00Z");
  const { sql, api } = await setup(undefined, () => clock);
  const attempt = (key: string, ip: string) =>
    api.handle(
      new Request("https://proxy.test/admin/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ key }),
      }),
      "/admin/api/session",
    );

  for (let i = 0; i < 10; i++) {
    assertEquals((await attempt("wrong", `10.0.0.${i}`)).status, 401);
  }
  const blocked = await attempt("wrong", "10.0.0.100");
  assertEquals(blocked.status, 429);
  assertEquals(blocked.headers.get("retry-after"), "60");

  // The limiter is global, not per x-forwarded-for bucket.
  assertEquals((await attempt(API_KEY, "10.0.0.101")).status, 429);

  clock = new Date(clock.getTime() + 60_001);
  assertEquals((await attempt("wrong", "10.0.0.102")).status, 401);
  sql.close();
});

Deno.test("a successful login resets the failure counter", async () => {
  const { sql, api } = await setup();
  const attempt = (key: string) =>
    api.handle(
      new Request("https://proxy.test/admin/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      }),
      "/admin/api/session",
    );

  for (let i = 0; i < 9; i++) assertEquals((await attempt("wrong")).status, 401);
  assertEquals((await attempt(API_KEY)).status, 204);
  for (let i = 0; i < 9; i++) assertEquals((await attempt("wrong")).status, 401);
  sql.close();
});

Deno.test("cookie admin API responses slide the session", async () => {
  let clock = new Date("2026-01-01T00:00:00Z");
  const { sql, api, session } = await setup(undefined, () => clock);
  const token = await session.issue(clock);
  clock = new Date("2026-01-25T00:00:00Z");

  const response = await api.handle(
    new Request("https://proxy.test/admin/api/accounts", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }),
    "/admin/api/accounts",
  );
  assertEquals(response.status, 200);
  const cookie = response.headers.get("set-cookie") ?? "";
  assertEquals(cookie.includes(`${SESSION_COOKIE}=`), true);
  const match = /Max-Age=(\d+)/.exec(cookie);
  assertEquals(Number(match?.[1]), 30 * 24 * 60 * 60);
  sql.close();
});

Deno.test("error responses also slide the session when it is due", async () => {
  let clock = new Date("2026-01-01T00:00:00Z");
  const { sql, api, session } = await setup(undefined, () => clock);
  const token = await session.issue(clock);
  clock = new Date("2026-01-25T00:00:00Z");

  const response = await api.handle(
    new Request("https://proxy.test/admin/api/accounts/999", {
      method: "PATCH",
      headers: {
        cookie: `${SESSION_COOKIE}=${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "x" }),
    }),
    "/admin/api/accounts/999",
  );
  assertEquals(response.status, 404);
  assertEquals((response.headers.get("set-cookie") ?? "").includes(SESSION_COOKIE), true);
  sql.close();
});

Deno.test("the renewal cookie max-age follows the capped token expiry", async () => {
  let clock = new Date("2026-01-01T00:00:00Z");
  const { sql, api, session } = await setup(undefined, () => clock);
  let token = await session.issue(clock);
  token = (await session.renew(token, new Date("2026-01-25T00:00:00Z")))!;
  token = (await session.renew(token, new Date("2026-02-20T00:00:00Z")))!;
  token = (await session.renew(token, new Date("2026-03-18T00:00:00Z")))!;
  clock = new Date("2026-03-27T00:00:00Z");

  const response = await api.handle(
    new Request("https://proxy.test/admin/api/accounts", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }),
    "/admin/api/accounts",
  );
  const match = /Max-Age=(\d+)/.exec(response.headers.get("set-cookie") ?? "");
  assertEquals(Number(match?.[1]), 5 * 24 * 60 * 60);
  sql.close();
});

Deno.test("api.matches covers every admin route", async () => {
  const { sql, api } = await setup();
  for (
    const path of [
      "/admin/api/session",
      "/admin/api/session/revoke",
      "/admin/api/accounts",
      "/admin/api/accounts/1",
      "/admin/api/accounts/test",
      "/admin/api/accounts/import",
      "/admin/api/settings",
      "/admin/api/logs",
      "/admin/api/overview",
      "/admin/api/gallery",
    ]
  ) {
    assertEquals(api.matches(path), true, path);
  }
  assertEquals(api.matches("/v1/models"), false);
  sql.close();
});

Deno.test("admin requests reject a non-admin path", async () => {
  const { sql, api } = await setup();
  await assertRejects(
    () => api.handle(new Request("https://proxy.test/elsewhere"), "/elsewhere"),
    ApiError,
  );
  sql.close();
});

Deno.test("partial settings updates preserve existing values", async () => {
  const { sql, json } = await setup();
  const current = await (await json("/admin/api/settings", "GET", undefined)).json();
  await json("/admin/api/settings", "PUT", {
    ...current,
    agnesBaseUrl: "https://custom.example/v1",
    probeConcurrency: 4,
  });

  const partial = await json("/admin/api/settings", "PUT", { maxAttempts: 5 });
  assertEquals(partial.status, 200);
  const body = await partial.json();
  assertEquals(body.maxAttempts, 5);
  assertEquals(body.probeConcurrency, 4);
  assertEquals(body.agnesBaseUrl, "https://custom.example/v1");
  sql.close();
});
