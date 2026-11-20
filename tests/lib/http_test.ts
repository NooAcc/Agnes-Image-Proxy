import { assert, assertEquals, assertRejects } from "@std/assert";
import { ApiError } from "../../lib/errors.ts";
import {
  addWarnings,
  asObject,
  bytesResponse,
  errorResponse,
  htmlResponse,
  jsonResponse,
  methodNotAllowed,
  normalizePath,
  readJsonBody,
} from "../../lib/http.ts";
import { MAX_REQUEST_BYTES } from "../../lib/limits.ts";

Deno.test("readJsonBody rejects a declared oversized body", async () => {
  const request = new Request("https://x/", {
    method: "POST",
    headers: { "content-length": String(MAX_REQUEST_BYTES + 1) },
  });
  await assertRejects(() => readJsonBody(request), ApiError, "body");
});

Deno.test("readJsonBody parses a valid JSON object", async () => {
  const request = new Request("https://x/", {
    method: "POST",
    body: JSON.stringify({ prompt: "x" }),
  });
  assertEquals(await readJsonBody(request), { prompt: "x" });
});

Deno.test("readJsonBody rejects malformed JSON with 400", async () => {
  const request = new Request("https://x/", { method: "POST", body: "{" });
  const error = await assertRejects(() => readJsonBody(request), ApiError);
  assertEquals(error.status, 400);
});

Deno.test("normalizePath strips trailing slashes but keeps root", () => {
  assertEquals(normalizePath("/v1/images/edits/"), "/v1/images/edits");
  assertEquals(normalizePath("/"), "/");
  assertEquals(normalizePath(""), "/");
});

Deno.test("jsonResponse sets JSON content type and merges warnings", async () => {
  const response = jsonResponse({ ok: true }, { headers: { "X-Test": "1" } });
  assertEquals(response.headers.get("content-type"), "application/json; charset=utf-8");
  assertEquals(response.headers.get("x-test"), "1");
  assertEquals(await response.json(), { ok: true });
});

Deno.test("addWarnings appends the X-Agnes-Warnings header", () => {
  const headers = new Headers();
  addWarnings(headers, ["quality", "background"]);
  addWarnings(headers, ["partial-success"]);
  assertEquals(headers.get("x-agnes-warnings"), "quality,background,partial-success");
});

Deno.test("errorResponse maps unknown errors to a 500 server_error", async () => {
  const response = errorResponse(new Error("kaboom"));
  assertEquals(response.status, 500);
  const body = await response.json();
  assertEquals(body.error.type, "server_error");
  assertEquals(response.headers.get("content-type"), "application/json; charset=utf-8");
});

Deno.test("errorResponse keeps ApiError status and headers", async () => {
  const response = errorResponse(
    new ApiError(429, "slow down", "rate_limit_error", null, null, { "retry-after": "120" }),
  );
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("retry-after"), "120");
  assertEquals(await response.json(), {
    error: { message: "slow down", type: "rate_limit_error", param: null, code: null },
  });
});

Deno.test("htmlResponse applies the strict console CSP", () => {
  const response = htmlResponse("<p>hi</p>");
  const csp = response.headers.get("content-security-policy") ?? "";
  assert(csp.includes("default-src 'none'"));
  assert(csp.includes("img-src 'self' data:"));
  assertEquals(response.headers.get("x-frame-options"), "DENY");
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(response.headers.get("referrer-policy"), "no-referrer");
  assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("bytesResponse returns bytes with a private cache and nosniff", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const response = bytesResponse(bytes, "image/png");
  assertEquals(response.headers.get("content-type"), "image/png");
  assertEquals(response.headers.get("cache-control"), "private, max-age=300");
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(new Uint8Array(await response.arrayBuffer()), bytes);
});

Deno.test("methodNotAllowed returns 405 and the Allow header", async () => {
  const response = methodNotAllowed(["GET", "POST"]);
  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "GET, POST");
  assertEquals(await response.json(), {
    error: {
      message: "method not allowed",
      type: "invalid_request_error",
      param: null,
      code: null,
    },
  });
});

Deno.test("asObject narrows plain objects and rejects arrays", () => {
  assertEquals(asObject({ a: 1 }), { a: 1 });
  assertEquals(asObject(null), null);
  assertEquals(asObject([]), null);
  assertEquals(asObject("x"), null);
});
