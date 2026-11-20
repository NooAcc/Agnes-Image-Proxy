import { assertEquals, assertRejects } from "@std/assert";
import { ApiError } from "../../lib/errors.ts";
import { createAccountStore, ensureSchema, maskKey } from "../../lib/accounts.ts";
import { createSessionSigner } from "../../lib/auth.ts";
import { createAdminApi, SESSION_COOKIE } from "../../lib/admin.ts";
import { createGalleryStore } from "../../lib/gallery.ts";
import { createRequestLogStore } from "../../lib/logs.ts";
import { createModelUsageStore } from "../../lib/model-usage.ts";
import { createSettingsStore } from "../../lib/settings.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";
import type { AgnesClient, AgnesClientFactory } from "../../lib/pool.ts";

const API_KEY = "proxy-key";

async function setup(clientFactory?: AgnesClientFactory) {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  const store = createAccountStore(sql);
  const settings = createSettingsStore(sql);
  const logs = createRequestLogStore(sql);
  const modelUsage = createModelUsageStore(sql);
  const gallery = createGalleryStore(sql);
  const session = createSessionSigner(API_KEY);
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
      ts: `2026-11-20T10:00:0${i}.000Z`,
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
      size: "1K 1:1",
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
    endpoint: "generations",
    day: "2026-11-20",
    ok: true,
    images: 2,
    at: "2026-11-20T10:00:00.000Z",
  });

  const response = await call("/admin/api/overview?day=2026-11-20");
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(typeof body.totals.requests, "number");
  assertEquals(body.totals.images, 2);
  assertEquals(body.models.length, 3);
  const flash = body.models.find((model: { id: string }) => model.id === "agnes-image-2.5-flash");
  assertEquals(flash.requests, 1);
  const unused = body.models.find((model: { id: string }) => model.id === "agnes-image-2.0-flash");
  assertEquals(unused.requests, 0);
  assertEquals(body.settings.defaultSize, "1K");
  assertEquals(typeof body.accounts.total, "number");
  assertEquals(body.trend.length, 14);
  assertEquals(body.trend[13].day, "2026-11-20");
  assertEquals(body.trend[13].requests, 1);
  assertEquals(body.trend[13].images, 2);
  assertEquals(body.trend[0].day, "2026-11-07");
  assertEquals(body.trend[0].requests, 0);

  const invalid = await call("/admin/api/overview?day=2026-13-40");
  assertEquals(invalid.status, 400);
  sql.close();
});

Deno.test("api.matches covers every admin route", async () => {
  const { sql, api } = await setup();
  for (
    const path of [
      "/admin/api/session",
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
