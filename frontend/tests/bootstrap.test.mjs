import assert from "node:assert/strict";
import test from "node:test";

import { runBootstrap } from "../web/bootstrap.ts";
import { safeAdminDestination } from "../web/contracts.ts";

function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function environment(responder) {
  const calls = [];
  const classes = new Set();
  const nodes = {
    '[data-role="boot-error"]': {
      hidden: true,
      textContent: "",
      querySelector(selector) {
        return selector === '[data-role="boot-error-text"]' ? nodes["boot-error-text"] : null;
      },
    },
    "boot-error-text": { textContent: "" },
    '[data-action="boot-retry"]': {
      handler: null,
      addEventListener(_name, handler) {
        this.handler = handler;
      },
    },
  };
  const location = {
    pathname: "/admin/gallery",
    hash: "",
    search: "",
    replaced: [],
    replace(url) {
      this.replaced.push(url);
      calls.push({ replace: url });
    },
  };
  const document = {
    documentElement: {
      classList: {
        add(name) {
          classes.add(name);
        },
        remove(name) {
          classes.delete(name);
        },
      },
    },
    querySelector(selector) {
      if (selector === '[data-role="boot-error-text"]') return nodes["boot-error-text"];
      return nodes[selector] || null;
    },
  };
  const A = {
    ready: null,
    halted: false,
    readyState: "booting",
    autoRefresh: {},
    apiCalls: [],
    async api(path) {
      this.apiCalls.push(path);
      return { items: [] };
    },
  };
  const win = {
    Agnes: A,
    location,
    document,
    Promise,
    fetch: async (path) => {
      calls.push({ fetch: path });
      return responder(path, calls.filter((entry) => entry.fetch).length);
    },
  };
  return { win, A, calls, classes, nodes, location };
}

test("bootstrap checks session then storage before any section query", async () => {
  const env = environment((path) => {
    if (path === "/admin/api/session") return reply(200, { authenticated: true });
    if (path === "/admin/api/storage") return reply(200, { initialized: true, mode: "local" });
    throw new Error(`unexpected ${path}`);
  });
  const running = runBootstrap(env.win, safeAdminDestination);
  const section = env.A.api("/admin/api/accounts");
  assert.equal(await running, true);
  assert.deepEqual(await section, { items: [] });
  assert.deepEqual(env.calls.filter((entry) => entry.fetch).map((entry) => entry.fetch), [
    "/admin/api/session",
    "/admin/api/storage",
  ]);
  assert.deepEqual(env.A.apiCalls, ["/admin/api/accounts"]);
  assert.equal(env.A.readyState, "ready");
  assert.ok(env.classes.has("is-ready"));
  assert.deepEqual(env.location.replaced, []);
});

test("a 401 on the session check stops work and returns to login", async () => {
  const env = environment(() => reply(401, { error: { code: "unauthorized" } }));
  env.location.pathname = "/admin/accounts";
  env.location.hash = "#logs";
  assert.equal(await runBootstrap(env.win, safeAdminDestination), false);
  assert.equal(env.A.halted, true);
  assert.deepEqual(env.location.replaced, [
    "/admin/login?next=" + encodeURIComponent("/admin#logs"),
  ]);
  assert.deepEqual(env.calls.filter((entry) => entry.fetch).map((entry) => entry.fetch), [
    "/admin/api/session",
  ]);
});

test("an uninitialized store or initialization_required redirects to setup", async () => {
  for (const responder of [
    () => reply(200, { initialized: false }),
    (path) => path === "/admin/api/session"
      ? reply(200, { authenticated: true })
      : reply(503, { error: { code: "initialization_required" } }),
  ]) {
    const env = environment(responder);
    assert.equal(await runBootstrap(env.win, safeAdminDestination), false);
    assert.deepEqual(env.location.replaced, ["/admin/setup"]);
    assert.equal(env.A.halted, true);
  }
});

test("storage-unavailable errors show retry instead of redirecting", async () => {
  const env = environment((path) => {
    if (path === "/admin/api/session") return reply(200, { authenticated: true });
    return reply(503, { error: { code: "service_unavailable" } });
  });
  assert.equal(await runBootstrap(env.win, safeAdminDestination), false);
  assert.deepEqual(env.location.replaced, []);
  assert.equal(env.A.halted, false);
  assert.equal(env.A.readyState, "error");
  assert.equal(env.nodes['[data-role="boot-error"]'].hidden, false);
  assert.match(env.nodes["boot-error-text"].textContent, /重试/);
  await assert.rejects(() => env.A.api("/admin/api/logs"));
  assert.deepEqual(env.A.apiCalls, []);
});

test("network failures show retry and can be retried", async () => {
  let failures = 1;
  const env = environment((path) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("offline");
    }
    if (path === "/admin/api/session") return reply(200, { authenticated: true });
    return reply(200, { initialized: true, mode: "local" });
  });
  assert.equal(await runBootstrap(env.win, safeAdminDestination), false);
  assert.deepEqual(env.location.replaced, []);
  assert.match(env.nodes["boot-error-text"].textContent, /重试/);

  const retry = env.nodes['[data-action="boot-retry"]'];
  assert.equal(typeof retry.handler, "function");
  retry.handler();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(env.A.readyState, "ready");
  assert.ok(env.classes.has("is-ready"));
});

test("a 403 from the storage check stays retryable, not a login redirect", async () => {
  const env = environment((path) => {
    if (path === "/admin/api/session") return reply(200, { authenticated: true });
    return reply(403, { error: { code: "origin_forbidden" } });
  });
  assert.equal(await runBootstrap(env.win, safeAdminDestination), false);
  assert.deepEqual(env.location.replaced, []);
  assert.equal(env.A.readyState, "error");
});
