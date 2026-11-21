import { assertEquals, assertRejects } from "@std/assert";
import { ApiError } from "../../lib/errors.ts";
import { createAccountStore, ensureSchema } from "../../lib/accounts.ts";
import { type AgnesClient, createAccountPool } from "../../lib/pool.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";

const OK_BODY = { created: 1, data: [{ b64_json: "AAA" }] };

function fakeFactory(handlers: Record<string, (call: number) => unknown>) {
  const calls: { apiKey: string; attempts: number }[] = [];
  const factory = ({ apiKey }: { apiKey: string; baseUrl: string; timeoutMs?: number }) => {
    const record = { apiKey, attempts: 0 };
    calls.push(record);
    return {
      generate: async () => {
        record.attempts++;
        const handler = handlers[apiKey];
        if (!handler) throw new Error(`no handler for ${apiKey}`);
        return await handler(record.attempts);
      },
    } as AgnesClient;
  };
  return { factory, calls };
}

async function setup(handlers: Record<string, (call: number) => unknown>) {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  const store = createAccountStore(sql);
  const a = await store.create({ name: "a", apiKey: "key-a" });
  const b = await store.create({ name: "b", apiKey: "key-b" });
  const { factory, calls } = fakeFactory(handlers);
  const pool = createAccountPool({ store, createClient: factory });
  return { sql, store, pool, a, b, calls };
}

Deno.test("pool rotates accounts across successes", async () => {
  const { sql, pool, calls } = await setup({
    "key-a": () => ({ status: 200, body: OK_BODY }),
    "key-b": () => ({ status: 200, body: OK_BODY }),
  });

  const order: string[] = [];
  for (let i = 0; i < 4; i++) {
    const result = await pool.gateway("https://up/v1").generate({
      path: "/images/generations",
      body: {},
    });
    order.push(result.account.name);
  }
  assertEquals(order, ["a", "b", "a", "b"]);
  assertEquals(calls.length, 4);
  sql.close();
});

Deno.test("pool fails over after a 401 and marks the account degraded", async () => {
  const { sql, store, pool, a } = await setup({
    "key-a": () => {
      throw new ApiError(401, "bad key", "authentication_error");
    },
    "key-b": () => ({ status: 200, body: OK_BODY }),
  });

  const result = await pool.gateway("https://up/v1").generate({
    path: "/images/generations",
    body: {},
  });
  assertEquals(result.account.name, "b");

  const row = await store.get(a.id);
  assertEquals(row?.status, "degraded");
  assertEquals(typeof row?.cooldownUntil, "string");
  assertEquals(new Date(row!.cooldownUntil!).getTime() > Date.now(), true);
  sql.close();
});

Deno.test("pool honours retry-after on 429", async () => {
  const { sql, store, pool, a } = await setup({
    "key-a": () => {
      throw new ApiError(429, "slow down", "rate_limit_error", null, null, {
        "retry-after": "120",
      });
    },
    "key-b": () => ({ status: 200, body: OK_BODY }),
  });

  const result = await pool.gateway("https://up/v1").generate({
    path: "/images/generations",
    body: {},
  });
  assertEquals(result.account.name, "b");

  const row = await store.get(a.id);
  const cooldownSeconds = (new Date(row!.cooldownUntil!).getTime() - Date.now()) / 1000;
  assertEquals(Math.abs(cooldownSeconds - 120) < 5, true);
  sql.close();
});

Deno.test("pool does not retry a 400", async () => {
  const { sql, store, pool, calls, a } = await setup({
    "key-a": () => {
      throw new ApiError(400, "bad prompt", "invalid_request_error");
    },
    "key-b": () => ({ status: 200, body: OK_BODY }),
  });

  const error = await assertRejects(() =>
    pool.gateway("https://up/v1").generate({ path: "/images/generations", body: {} })
  );
  assertEquals(error instanceof ApiError && error.status, 400);
  assertEquals(calls.length, 1);
  assertEquals((await store.get(a.id))?.failCount, 0);
  sql.close();
});

async function setupThree(handlers: Record<string, (call: number) => unknown>) {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  const store = createAccountStore(sql);
  await store.create({ name: "a", apiKey: "key-a" });
  await store.create({ name: "b", apiKey: "key-b" });
  await store.create({ name: "c", apiKey: "key-c" });
  const { factory, calls } = fakeFactory(handlers);
  const pool = createAccountPool({ store, createClient: factory });
  return { sql, store, pool, calls };
}

Deno.test("a single 429 is returned as 429 with retry-after", async () => {
  const { sql, pool } = await setup({
    "key-a": () => {
      throw new ApiError(429, "slow", "rate_limit_error", null, null, {
        "retry-after": "999999",
      });
    },
    "key-b": () => ({ status: 200, body: OK_BODY }),
  });
  // Use maxAttempts: 1 so the only attempt is the 429.
  const error = await assertRejects(() =>
    pool.gateway("https://up/v1", undefined, { maxAttempts: 1 })
      .generate({ path: "/images/generations", body: {} })
  );
  assertEquals(error instanceof ApiError && error.status, 429);
  assertEquals(error instanceof ApiError && error.headers.get("retry-after"), "900");
  sql.close();
});

Deno.test("three 502s return 502, not 503", async () => {
  const { sql, pool } = await setupThree({
    "key-a": () => {
      throw new ApiError(502, "upstream exploded");
    },
    "key-b": () => {
      throw new ApiError(502, "upstream exploded");
    },
    "key-c": () => {
      throw new ApiError(502, "upstream exploded");
    },
  });
  const error = await assertRejects(() =>
    pool.gateway("https://up/v1").generate({ path: "/images/generations", body: {} })
  );
  assertEquals(error instanceof ApiError && error.status, 502);
  assertEquals(error instanceof ApiError && error.code, "upstream_unavailable");
  assertEquals(error instanceof ApiError && error.message.includes("3"), true);
  sql.close();
});

Deno.test("429 beats 502 across accounts", async () => {
  const { sql, pool } = await setupThree({
    "key-a": () => {
      throw new ApiError(502, "upstream exploded");
    },
    "key-b": () => {
      throw new ApiError(429, "slow down", "rate_limit_error");
    },
    "key-c": () => {
      throw new ApiError(502, "upstream exploded");
    },
  });
  const error = await assertRejects(() =>
    pool.gateway("https://up/v1").generate({ path: "/images/generations", body: {} })
  );
  assertEquals(error instanceof ApiError && error.status, 429);
  assertEquals(error instanceof ApiError && error.code, "rate_limit_exceeded");
  sql.close();
});

Deno.test("all 401s return 503", async () => {
  const { sql, pool } = await setupThree({
    "key-a": () => {
      throw new ApiError(401, "bad key", "authentication_error");
    },
    "key-b": () => {
      throw new ApiError(401, "bad key", "authentication_error");
    },
    "key-c": () => {
      throw new ApiError(401, "bad key", "authentication_error");
    },
  });
  const error = await assertRejects(() =>
    pool.gateway("https://up/v1").generate({ path: "/images/generations", body: {} })
  );
  assertEquals(error instanceof ApiError && error.status, 503);
  sql.close();
});

Deno.test("pool passes the timeout to the client factory", async () => {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  const store = createAccountStore(sql);
  await store.create({ name: "a", apiKey: "key-a" });
  const seen: { timeoutMs?: number }[] = [];
  const pool = createAccountPool({
    store,
    createClient: ({ timeoutMs }) => {
      seen.push({ timeoutMs });
      return {
        generate: () => Promise.resolve({ status: 200, body: OK_BODY }),
      } as AgnesClient;
    },
  });

  await pool.gateway("https://up/v1", undefined, { timeoutMs: 90_000, maxAttempts: 1 })
    .generate({ path: "/images/generations", body: {} });
  assertEquals(seen, [{ timeoutMs: 90_000 }]);
  sql.close();
});
