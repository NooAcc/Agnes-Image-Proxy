import { assertEquals } from "@std/assert";
import { postImageServiceBatch } from "../../lib/image-service.ts";

Deno.test("posts a top-level JSON array to /api/batch", async () => {
  let url = "";
  let body: unknown = null;
  const result = await postImageServiceBatch(
    [{ uuid: "1", url: "https://a.example/x.png", params: { format: "json" } }],
    {
      baseUrl: "https://img.example",
      timeoutMs: 1000,
      fetchImpl: ((input, init) => {
        url = String(input);
        body = JSON.parse(String(init?.body));
        return Promise.resolve(
          new Response(JSON.stringify({ "1": { success: true, data: { width: 2 } } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }) as typeof fetch,
    },
  );
  assertEquals(url, "https://img.example/api/batch");
  assertEquals(body, [{ uuid: "1", url: "https://a.example/x.png", params: { format: "json" } }]);
  assertEquals(result, {
    ok: true,
    results: { "1": { success: true, data: { width: 2 } } },
    error: null,
  });
});

Deno.test("reports non-2xx, invalid payloads and network errors", async () => {
  const base = { baseUrl: "https://img.example", timeoutMs: 1000 };
  assertEquals(
    await postImageServiceBatch([], {
      ...base,
      fetchImpl: (() => Promise.resolve(new Response("boom", { status: 500 }))) as typeof fetch,
    }),
    { ok: false, results: {}, error: "image service responded 500" },
  );
  assertEquals(
    await postImageServiceBatch([], {
      ...base,
      fetchImpl: (() => Promise.resolve(new Response("[]", { status: 200 }))) as typeof fetch,
    }),
    { ok: false, results: {}, error: "image service returned an invalid response" },
  );
  assertEquals(
    await postImageServiceBatch([], {
      ...base,
      fetchImpl: (() => Promise.reject(new Error("network down"))) as typeof fetch,
    }),
    { ok: false, results: {}, error: "network down" },
  );
});
