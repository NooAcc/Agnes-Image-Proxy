import { assertEquals, assertRejects } from "@std/assert";
import { ApiError } from "../../lib/errors.ts";
import { createAgnesClient, upstreamMessage } from "../../lib/agnes.ts";

const BASE = "https://apihub.agnes-ai.com/v1";

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(handler(url, init ?? {}));
  };
  return { impl: impl as typeof fetch, calls };
}

Deno.test("client posts JSON to the Agnes generations path with bearer auth", async () => {
  const { impl, calls } = fakeFetch(() =>
    new Response(JSON.stringify({ created: 1, data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  const client = createAgnesClient({ baseUrl: BASE, apiKey: "secret", fetchImpl: impl });
  const result = await client.generate({ path: "/images/generations", body: { prompt: "x" } });

  assertEquals(calls[0].url, "https://apihub.agnes-ai.com/v1/images/generations");
  const headers = new Headers(calls[0].init.headers);
  assertEquals(headers.get("authorization"), "Bearer secret");
  assertEquals(headers.get("content-type"), "application/json");
  assertEquals(JSON.parse(String(calls[0].init.body)), { prompt: "x" });
  assertEquals(result, { status: 200, body: { created: 1, data: [] } });
});

Deno.test("client preserves rate limit status and retry-after", async () => {
  const { impl } = fakeFetch(() =>
    new Response(JSON.stringify({ error: { message: "slow down" } }), {
      status: 429,
      headers: { "retry-after": "120" },
    })
  );
  const client = createAgnesClient({ baseUrl: BASE, apiKey: "secret", fetchImpl: impl });
  const error = await assertRejects(() =>
    client.generate({ path: "/images/generations", body: {} })
  );
  assertEquals(error instanceof ApiError, true);
  if (error instanceof ApiError) {
    assertEquals(error.status, 429);
    assertEquals(error.headers.get("retry-after"), "120");
  }
});

Deno.test("client keeps 401 and maps 500 to 502 with the upstream message", async () => {
  const unauthorized = fakeFetch(() => new Response("nope", { status: 401 }));
  const client401 = createAgnesClient({
    baseUrl: BASE,
    apiKey: "secret",
    fetchImpl: unauthorized.impl,
  });
  const error401 = await assertRejects(() =>
    client401.generate({ path: "/images/generations", body: {} })
  );
  assertEquals(error401 instanceof ApiError && error401.status, 401);

  const broken = fakeFetch(() =>
    new Response(JSON.stringify({ error: { message: "upstream exploded" } }), { status: 500 })
  );
  const client500 = createAgnesClient({ baseUrl: BASE, apiKey: "secret", fetchImpl: broken.impl });
  const error500 = await assertRejects(() =>
    client500.generate({ path: "/images/generations", body: {} })
  );
  assertEquals(error500 instanceof ApiError && error500.status, 502);
  assertEquals(error500 instanceof ApiError && error500.message, "upstream exploded");
});

Deno.test("client maps aborts to a 504 timeout", async () => {
  const { impl } = fakeFetch(() => {
    throw new DOMException("The operation was aborted.", "AbortError");
  });
  const client = createAgnesClient({ baseUrl: BASE, apiKey: "secret", fetchImpl: impl });
  const error = await assertRejects(() =>
    client.generate({ path: "/images/generations", body: {} })
  );
  assertEquals(error instanceof ApiError && error.status, 504);
});

Deno.test("upstreamMessage prefers the nested error message", async () => {
  assertEquals(
    upstreamMessage({ error: { message: "n must be 1", type: "invalid_request" } }, 400),
    "n must be 1",
  );
  assertEquals(upstreamMessage("plain text", 500), "plain text");

  const { impl } = fakeFetch(() =>
    new Response(
      JSON.stringify({
        error: { message: "n must be 1", type: "invalid_request", code: "invalid_request" },
      }),
      { status: 400 },
    )
  );
  const client = createAgnesClient({ baseUrl: BASE, apiKey: "secret", fetchImpl: impl });
  const error = await assertRejects(() =>
    client.generate({ path: "/images/generations", body: { n: 2 } })
  );
  assertEquals(error instanceof ApiError && error.message, "n must be 1");
});
