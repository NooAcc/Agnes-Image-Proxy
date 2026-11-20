import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ApiError } from "../../lib/errors.ts";
import {
  createCachedSettings,
  createSettingsStore,
  DEFAULT_SETTINGS,
  validateSettings,
} from "../../lib/settings.ts";
import { createNodeSqliteExecutor } from "../../lib/testing/node-sqlite-executor.ts";

async function freshStore() {
  const sql = createNodeSqliteExecutor();
  await sql.execute(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  return { sql, store: createSettingsStore(sql) };
}

Deno.test("settings default to the documented values", async () => {
  const { sql, store } = await freshStore();
  assertEquals(await store.read(), DEFAULT_SETTINGS);
  assertEquals(DEFAULT_SETTINGS.agnesBaseUrl, "https://apihub.agnes-ai.com/v1");
  assertEquals(DEFAULT_SETTINGS.defaultResponseFormat, "b64_json");
  assertEquals(DEFAULT_SETTINGS.defaultSize, "1K");
  assertEquals(DEFAULT_SETTINGS.defaultRatio, "1:1");
  assertEquals(DEFAULT_SETTINGS.imageParamMode, "auto");
  assertEquals(DEFAULT_SETTINGS.probeModel, "agnes-image-2.5-flash");
  assertEquals(DEFAULT_SETTINGS.probeConcurrency, 2);
  assertEquals(DEFAULT_SETTINGS.requestTimeoutMs, 300000);
  assertEquals(DEFAULT_SETTINGS.autoRefreshIntervalMs, 5000);
  assertEquals(DEFAULT_SETTINGS.maxAttempts, 3);
  sql.close();
});

Deno.test("settings write then read back", async () => {
  const { sql, store } = await freshStore();
  const next = { ...DEFAULT_SETTINGS, probeConcurrency: 4, defaultSize: "2K" as const };
  await store.write(next);
  assertEquals(await store.read(), next);
  sql.close();
});

Deno.test("validateSettings rejects a non-https base URL but allows localhost", () => {
  assertThrows(
    () => validateSettings({ agnesBaseUrl: "http://agnes.example/v1" }),
    ApiError,
  );
  assertEquals(
    validateSettings({ agnesBaseUrl: "http://localhost:8080/v1" }).agnesBaseUrl,
    "http://localhost:8080/v1",
  );
  assertEquals(
    validateSettings({ agnesBaseUrl: "https://apihub.agnes-ai.com/v1/" }).agnesBaseUrl,
    "https://apihub.agnes-ai.com/v1",
  );
});

Deno.test("validateSettings bounds probe concurrency and timeout", () => {
  assertThrows(() => validateSettings({ probeConcurrency: 0 }), ApiError);
  assertThrows(() => validateSettings({ probeConcurrency: 11 }), ApiError);
  assertThrows(() => validateSettings({ requestTimeoutMs: 59999 }), ApiError);
  assertThrows(() => validateSettings({ requestTimeoutMs: 360001 }), ApiError);
});

Deno.test("validateSettings bounds the console auto refresh interval", () => {
  assertEquals(validateSettings({ autoRefreshIntervalMs: 2000 }).autoRefreshIntervalMs, 2000);
  assertEquals(validateSettings({ autoRefreshIntervalMs: 60000 }).autoRefreshIntervalMs, 60000);
  assertThrows(() => validateSettings({ autoRefreshIntervalMs: 1999 }), ApiError);
  assertThrows(() => validateSettings({ autoRefreshIntervalMs: 60001 }), ApiError);
});

Deno.test("validateSettings rejects unknown enum values", () => {
  assertThrows(() => validateSettings({ defaultResponseFormat: "png" }), ApiError);
  assertThrows(() => validateSettings({ imageParamMode: "both" }), ApiError);
  assertThrows(() => validateSettings({ defaultSize: "8K" }), ApiError);
});

Deno.test("cached settings refresh after the TTL and on write", async () => {
  const { sql, store } = await freshStore();
  let clock = 1_000_000;
  const cached = createCachedSettings(store, 10_000, () => clock);

  assertEquals((await cached.read()).defaultSize, "1K");

  // An out-of-band database write is invisible until the TTL expires.
  await store.write({ ...DEFAULT_SETTINGS, defaultSize: "3K" });
  assertEquals((await cached.read()).defaultSize, "1K");
  clock += 10_001;
  assertEquals((await cached.read()).defaultSize, "3K");

  // Writing through the cache takes effect immediately.
  await cached.write({ ...DEFAULT_SETTINGS, defaultSize: "4K" });
  assertEquals((await cached.read()).defaultSize, "4K");
  sql.close();
});

Deno.test("settings store rejects malformed JSON in the database", async () => {
  const { sql, store } = await freshStore();
  await sql.execute(
    "INSERT INTO settings (key, value, updated_at) VALUES ('defaultSize', 'not-json', 'x')",
  );
  await assertRejects(() => store.read(), Error);
  sql.close();
});
