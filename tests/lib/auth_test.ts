import { assert, assertEquals, assertFalse } from "@std/assert";
import { ensureSchema } from "../../lib/accounts.ts";
import {
  createAuthStateStore,
  createSessionService,
  readCookie,
  timingSafeEqual,
} from "../../lib/auth.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";

async function setup() {
  const sql = createNodeSqliteExecutor();
  await ensureSchema(sql);
  return { sql, authState: createAuthStateStore(sql) };
}

Deno.test("session service accepts its own token and rejects tampering", async () => {
  const { sql, authState } = await setup();
  const session = createSessionService("secret", authState);
  const token = await session.issue(new Date("2026-01-01T00:00:00Z"));
  assert(await session.verify(token, new Date("2026-01-02T00:00:00Z")));
  assertEquals(await session.verify(token + "x", new Date("2026-01-02T00:00:00Z")), null);
  sql.close();
});

Deno.test("session service rejects an expired token", async () => {
  const { sql, authState } = await setup();
  const session = createSessionService("secret", authState, { ttlMs: 60_000 });
  const token = await session.issue(new Date("2026-01-01T00:00:00Z"));
  assertEquals(await session.verify(token, new Date("2026-01-01T00:02:00Z")), null);
  sql.close();
});

Deno.test("revoking the epoch invalidates every issued token", async () => {
  const { sql, authState } = await setup();
  const session = createSessionService("secret", authState);
  const token = await session.issue(new Date("2026-01-01T00:00:00Z"));
  assert(await session.verify(token, new Date("2026-01-02T00:00:00Z")));
  assertEquals(await session.revokeAll(), 2);
  assertEquals(await session.verify(token, new Date("2026-01-02T00:00:00Z")), null);
  sql.close();
});

Deno.test("renew issues a new token only inside the renewal window", async () => {
  const { sql, authState } = await setup();
  const session = createSessionService("secret", authState);
  const issued = await session.issue(new Date("2026-01-01T00:00:00Z"));

  // Twenty days remain: not inside the seven-day window.
  assertEquals(await session.renew(issued, new Date("2026-01-11T00:00:00Z")), null);

  const renewed = await session.renew(issued, new Date("2026-01-25T00:00:00Z"));
  assert(renewed);
  const claims = await session.verify(renewed!, new Date("2026-01-25T00:00:00Z"));
  assertEquals(claims?.iat, new Date("2026-01-01T00:00:00Z").getTime());
  assertEquals(claims?.exp, new Date("2026-02-24T00:00:00Z").getTime());
  sql.close();
});

Deno.test("renew never extends past iat + 90 days", async () => {
  const { sql, authState } = await setup();
  const session = createSessionService("secret", authState);
  let token = await session.issue(new Date("2026-01-01T00:00:00Z"));
  token = (await session.renew(token, new Date("2026-01-25T00:00:00Z")))!;
  token = (await session.renew(token, new Date("2026-02-20T00:00:00Z")))!;
  token = (await session.renew(token, new Date("2026-03-18T00:00:00Z")))!;

  const claims = await session.verify(token, new Date("2026-03-27T00:00:00Z"));
  assertEquals(claims?.exp, new Date("2026-04-01T00:00:00Z").getTime());
  assertEquals(await session.renew(token, new Date("2026-04-01T00:00:00Z")), null);
  sql.close();
});

Deno.test("forged tokens do not derive keys for arbitrary epochs", async () => {
  const { sql, authState } = await setup();
  const session = createSessionService("secret", authState);
  const proto = SubtleCrypto.prototype as unknown as {
    importKey: (...args: unknown[]) => Promise<CryptoKey>;
  };
  const original = proto.importKey;
  let imports = 0;
  proto.importKey = (...args: unknown[]) => {
    imports++;
    return original.apply(crypto.subtle, args);
  };

  try {
    const payload = btoa(
      JSON.stringify({ v: 987654321, iat: 1, exp: Date.now() + 1_000_000 }),
    ).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    for (let i = 0; i < 5; i++) {
      assertEquals(await session.verify(`${payload}.signature${i}`, new Date()), null);
    }
    assertEquals(imports, 0);
  } finally {
    proto.importKey = original;
  }
  sql.close();
});

Deno.test("auth state reads and bumps the session epoch", async () => {
  const { sql } = await setup();
  const state = createAuthStateStore(sql);
  assertEquals(await state.getSessionEpoch(), 1);
  assertEquals(await state.bumpSessionEpoch(), 2);
  assertEquals(await state.getSessionEpoch(), 2);
  sql.close();
});

Deno.test("auth state caches the epoch for ten seconds", async () => {
  const { sql } = await setup();
  let clock = 0;
  const state = createAuthStateStore(sql, { ttlMs: 10_000, now: () => clock });
  assertEquals(await state.getSessionEpoch(), 1);

  await sql.execute("UPDATE auth_state SET value = '5' WHERE key = 'session_epoch'");
  assertEquals(await state.getSessionEpoch(), 1);
  clock += 10_001;
  assertEquals(await state.getSessionEpoch(), 5);
  sql.close();
});

Deno.test("timingSafeEqual does not leak length", () => {
  assertFalse(timingSafeEqual("short", "a-much-longer-secret"));
  assert(timingSafeEqual("same", "same"));
});

Deno.test("readCookie finds a named cookie", () => {
  const request = new Request("https://x/", {
    headers: { cookie: "a=1; agnes_session=abc.def; b=2" },
  });
  assert(readCookie(request, "agnes_session") === "abc.def");
  assert(readCookie(request, "missing") === null);
});
