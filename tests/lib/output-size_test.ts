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

Deno.test("measures b64 output images", async () => {
  const result = await measureOutputImages([
    { url: null, b64_json: encodeBase64(pngHeader(900, 1200)), revised_prompt: null },
  ]);
  assertEquals(result.sizes, [{ width: 900, height: 1200 }]);
  assertEquals(result.first, { width: 900, height: 1200 });
  assertEquals(result.warnings, []);
});

Deno.test("measures URL output images through a guarded fetch", async () => {
  const fetchImpl = () =>
    Promise.resolve(new Response(pngHeader(864, 1152) as unknown as BodyInit));
  const result = await measureOutputImages(
    [{ url: "https://out.example/a.png", b64_json: null, revised_prompt: null }],
    fetchImpl as typeof fetch,
  );
  assertEquals(result.sizes, [{ width: 864, height: 1152 }]);
});

Deno.test("measurement failure is non-fatal and warns", async () => {
  const fetchImpl = () => Promise.reject(new Error("boom"));
  const result = await measureOutputImages(
    [{ url: "https://out.example/a.png", b64_json: null, revised_prompt: null }],
    fetchImpl as typeof fetch,
  );
  assertEquals(result.sizes, [null]);
  assertEquals(result.first, null);
  assertEquals(result.warnings.includes("size-measure-failed"), true);
});

Deno.test("unexpected measurement errors are swallowed", async () => {
  const fetchImpl = () => Promise.resolve(null) as unknown as Promise<Response>;
  const result = await measureOutputImages(
    [{ url: "https://out.example/a.png", b64_json: null, revised_prompt: null }],
    fetchImpl as unknown as typeof fetch,
  );
  assertEquals(result.sizes, [null]);
  assertEquals(result.first, null);
  assertEquals(result.warnings.includes("size-measure-failed"), true);
});
