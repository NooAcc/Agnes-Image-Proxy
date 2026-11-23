import { assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { measureOutputImages } from "../../lib/output-size.ts";

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function batchResponse(entries: Record<string, unknown>): Response {
  return new Response(JSON.stringify(entries), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("measures URL images through image service metadata", async () => {
  let body: unknown = null;
  const result = await measureOutputImages(
    [{ url: "https://out.example/a.png", b64_json: null, revised_prompt: null }],
    {
      imageServiceBaseUrl: "https://img.example",
      fetchImpl: ((_input, init) => {
        body = JSON.parse(String(init?.body));
        return Promise.resolve(batchResponse({
          "0": {
            success: true,
            data: { width: 864, height: 1152, format: "png", sourceContentType: "image/png" },
          },
        }));
      }) as typeof fetch,
    },
  );
  assertEquals(body, [
    { uuid: "0", url: "https://out.example/a.png", params: { format: "json" } },
  ]);
  assertEquals(result.sizes, [{ width: 864, height: 1152 }]);
  assertEquals(result.formats, ["png"]);
  assertEquals(result.warnings, []);
});

Deno.test("measures base64 images and normalizes jpg to jpeg", async () => {
  const result = await measureOutputImages(
    [{ url: null, b64_json: encodeBase64(pngHeader(10, 20)), revised_prompt: null }],
    {
      imageServiceBaseUrl: "https://img.example",
      fetchImpl: (() =>
        Promise.resolve(batchResponse({
          "0": { success: true, data: { width: 10, height: 20, format: "jpg" } },
        }))) as typeof fetch,
    },
  );
  assertEquals(result.sizes, [{ width: 10, height: 20 }]);
  assertEquals(result.formats, ["jpeg"]);
});

Deno.test("does nothing when the image service is not configured", async () => {
  let calls = 0;
  const result = await measureOutputImages(
    [{ url: "https://out.example/a.png", b64_json: null, revised_prompt: null }],
    {
      imageServiceBaseUrl: "",
      fetchImpl: (() => {
        calls++;
        return Promise.reject(new Error("should not be called"));
      }) as typeof fetch,
    },
  );
  assertEquals(calls, 0);
  assertEquals(result.sizes, [null]);
  assertEquals(result.formats, [null]);
  assertEquals(result.first, null);
  assertEquals(result.warnings, []);
});

Deno.test("measurement failures are non-fatal and warn once", async () => {
  const result = await measureOutputImages(
    [
      { url: "https://out.example/a.png", b64_json: null, revised_prompt: null },
      { url: "https://out.example/b.png", b64_json: null, revised_prompt: null },
    ],
    {
      imageServiceBaseUrl: "https://img.example",
      fetchImpl: (() => Promise.reject(new Error("boom"))) as typeof fetch,
    },
  );
  assertEquals(result.sizes, [null, null]);
  assertEquals(result.formats, [null, null]);
  assertEquals(result.warnings, ["size-measure-failed"]);
});

Deno.test("chunks more than 20 images into multiple metadata requests", async () => {
  let calls = 0;
  const images = Array.from({ length: 21 }, (_, index) => ({
    url: `https://out.example/${index}.png`,
    b64_json: null,
    revised_prompt: null,
  }));
  await measureOutputImages(images, {
    imageServiceBaseUrl: "https://img.example",
    fetchImpl: (() => {
      calls++;
      return Promise.resolve(batchResponse({}));
    }) as typeof fetch,
  });
  assertEquals(calls, 2);
});
