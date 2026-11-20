import { assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "../../lib/config.ts";

function env(values: Record<string, string>) {
  return (key: string) => values[key];
}

Deno.test("loadConfig refuses to boot without the three required variables", () => {
  assertThrows(() => loadConfig(() => undefined), Error);
});

Deno.test("loadConfig parses CORS origins and port", () => {
  const config = loadConfig(env({
    PROXY_API_KEY: "k",
    TURSO_DATABASE_URL: "libsql://x",
    TURSO_AUTH_TOKEN: "t",
    PORT: "9000",
    CORS_ALLOWED_ORIGINS: "https://a.example",
  }));
  assertEquals(config.port, 9000);
  assertEquals(config.corsAllowedOrigins, ["https://a.example"]);
});

Deno.test("loadConfig defaults the port and disables CORS", () => {
  const config = loadConfig(env({
    PROXY_API_KEY: "k",
    TURSO_DATABASE_URL: "libsql://x",
    TURSO_AUTH_TOKEN: "t",
  }));
  assertEquals(config.port, 8000);
  assertEquals(config.corsAllowedOrigins, []);
});

Deno.test("loadConfig rejects an out-of-range port and malformed CORS origins", () => {
  const base = { PROXY_API_KEY: "k", TURSO_DATABASE_URL: "libsql://x", TURSO_AUTH_TOKEN: "t" };
  assertThrows(() => loadConfig(env({ ...base, PORT: "0" })), Error);
  assertThrows(() => loadConfig(env({ ...base, PORT: "70000" })), Error);
  assertThrows(() => loadConfig(env({ ...base, CORS_ALLOWED_ORIGINS: "ftp://a.example" })), Error);
  assertThrows(
    () => loadConfig(env({ ...base, CORS_ALLOWED_ORIGINS: "https://a.example/path" })),
    Error,
  );
});

Deno.test("loadConfig splits multiple CORS origins", () => {
  const config = loadConfig(env({
    PROXY_API_KEY: "k",
    TURSO_DATABASE_URL: "libsql://x",
    TURSO_AUTH_TOKEN: "t",
    CORS_ALLOWED_ORIGINS: "https://a.example, http://localhost:3000",
  }));
  assertEquals(config.corsAllowedOrigins, ["https://a.example", "http://localhost:3000"]);
});
