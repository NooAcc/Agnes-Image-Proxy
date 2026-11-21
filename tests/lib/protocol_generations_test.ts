import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { ApiError } from "../../lib/errors.ts";
import {
  agnesPayload,
  mergeNormalizedResponses,
  normalizeAgnesResponse,
  type ParsedImageRequest,
  parseImageRequestJson,
} from "../../lib/protocol.ts";

const defaults = {
  defaultSize: "1K",
  defaultResponseFormat: "b64_json",
} as const;

function parse(raw: unknown): Promise<ParsedImageRequest> {
  return parseImageRequestJson(raw, "generations", defaults);
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function dataUri(width: number, height: number): string {
  return `data:image/png;base64,${encodeBase64(pngHeader(width, height))}`;
}

function pngResponse(width: number, height: number): Response {
  return new Response(pngHeader(width, height) as unknown as BodyInit);
}

Deno.test("parses the minimal generation request", async () => {
  const request = await parse({
    model: "agnes-image-2.5-flash",
    prompt: "x",
    size: "1024x1024",
  });
  assertEquals(request.n, 1);
  assertEquals(request.size.tier, "1K");
  assertEquals(request.size.ratio, "1:1");
  assertEquals(request.responseFormat, "b64_json");
  assertEquals(request.images, []);
  assertEquals(request.warnings, []);
});

Deno.test("response_format and return_base64 select the response format", async () => {
  assertEquals(
    (await parse({ model: "m", prompt: "p", response_format: "url" })).responseFormat,
    "url",
  );
  assertEquals(
    (await parse({ model: "m", prompt: "p", return_base64: false })).responseFormat,
    "url",
  );
  assertEquals(
    (await parse({ model: "m", prompt: "p", return_base64: true })).responseFormat,
    "b64_json",
  );
});

Deno.test("n must be a positive integer without an upper cap", async () => {
  for (const n of [0, 1.5, "3", -1]) {
    const error = await assertRejects(() => parse({ model: "m", prompt: "p", n }), ApiError);
    assertEquals(error.status, 400);
  }
  assertEquals((await parse({ model: "m", prompt: "p", n: 5 })).n, 5);
  assertEquals((await parse({ model: "m", prompt: "p", n: 25 })).n, 25);
});

Deno.test("unsupported and unknown fields become warnings", async () => {
  const request = await parse({
    model: "m",
    prompt: "p",
    quality: "high",
    background: "opaque",
    output_format: "jpeg",
    mystery: 1,
  });
  for (const warning of ["quality", "background", "output_format", "mystery"]) {
    assertEquals(request.warnings.includes(warning), true, `missing warning ${warning}`);
  }
});

Deno.test("extra_body is preserved", async () => {
  const request = await parse({ model: "m", prompt: "p", extra_body: { foo: 1 } });
  assertEquals(request.extraBody.foo, 1);
});

Deno.test("model and prompt are required", async () => {
  await assertRejects(() => parse({ prompt: "p" }), ApiError);
  await assertRejects(() => parse({ model: "m" }), ApiError);
  await assertRejects(() => parse({ model: "m", prompt: "  " }), ApiError);
});

Deno.test("stream and partial_images are rejected", async () => {
  const streamError = await assertRejects(
    () => parse({ model: "m", prompt: "p", stream: true }),
    ApiError,
  );
  assertEquals(streamError.param, "stream");
  assertEquals(streamError.code, "unsupported_parameter");
  await assertRejects(() => parse({ model: "m", prompt: "p", partial_images: 2 }), ApiError);
});

Deno.test("tier payload requests base64 at the top level", async () => {
  const payload = agnesPayload(
    await parse({ model: "m", prompt: "p", size: "1024x1024" }),
    "nested",
  );
  assertEquals(payload.path, "/images/generations");
  assertEquals(payload.body, {
    model: "m",
    prompt: "p",
    size: "1K",
    ratio: "1:1",
    return_base64: true,
  });
});

Deno.test("an explicit tier omits ratio from the payload", async () => {
  const parsed = await parseImageRequestJson(
    { model: "agnes-image-2.5-flash", prompt: "x", size: "2K" },
    "generations",
    { defaultSize: "1K", defaultResponseFormat: "b64_json" },
  );
  const payload = agnesPayload(parsed, "nested");
  assertEquals(payload.body.size, "2K");
  assertEquals("ratio" in payload.body, false);
});

Deno.test("url responses move response_format into extra_body", async () => {
  const payload = agnesPayload(
    await parse({ model: "m", prompt: "p", size: "1024x1024", response_format: "url" }),
    "nested",
  );
  assertEquals(payload.body, {
    model: "m",
    prompt: "p",
    size: "1K",
    ratio: "1:1",
    extra_body: { response_format: "url" },
  });
});

Deno.test("extra_body keys are merged without duplicating consumed ones", async () => {
  const payload = agnesPayload(
    await parse({ model: "m", prompt: "p", extra_body: { foo: 1, return_base64: false } }),
    "nested",
  );
  assertEquals(payload.body.extra_body, { foo: 1 });
});

Deno.test("omitted size with a local reference becomes an exact WxH payload", async () => {
  const parsed = await parseImageRequestJson(
    {
      model: "agnes-image-2.5-flash",
      prompt: "x",
      images: [dataUri(900, 1200)],
    },
    "generations",
    { defaultSize: "1K", defaultResponseFormat: "b64_json" },
  );
  const payload = agnesPayload(parsed, "nested");
  assertEquals(payload.body.size, "900x1200");
  assertEquals("ratio" in payload.body, false);
});

Deno.test("explicit size never fetches a URL reference", async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls++;
    return Promise.resolve(pngResponse(900, 1200));
  };
  await parseImageRequestJson(
    {
      model: "agnes-image-2.5-flash",
      prompt: "x",
      size: "2K",
      images: ["https://a.example/x.png"],
    },
    "generations",
    { defaultSize: "1K", defaultResponseFormat: "b64_json" },
    undefined,
    { fetchImpl },
  );
  assertEquals(calls, 0);
});

Deno.test("auto with a URL reference fetches its dimensions and passes WxH", async () => {
  const fetchImpl = () => Promise.resolve(pngResponse(900, 1200));
  const parsed = await parseImageRequestJson(
    {
      model: "agnes-image-2.5-flash",
      prompt: "x",
      size: "auto",
      images: ["https://a.example/x.png"],
    },
    "generations",
    { defaultSize: "1K", defaultResponseFormat: "b64_json" },
    undefined,
    { fetchImpl },
  );
  const payload = agnesPayload(parsed, "nested");
  assertEquals(payload.body.size, "900x1200");
});

Deno.test("auto with an explicit ratio sends the ratio alongside WxH", async () => {
  const parsed = await parseImageRequestJson(
    {
      model: "agnes-image-2.5-flash",
      prompt: "x",
      ratio: "16:9",
      images: [dataUri(900, 1200)],
    },
    "generations",
    { defaultSize: "1K", defaultResponseFormat: "b64_json" },
  );
  const payload = agnesPayload(parsed, "nested");
  assertEquals(payload.body.size, "900x1200");
  assertEquals(payload.body.ratio, "16:9");
});

Deno.test("no reference and no size keeps the default tier without a ratio", async () => {
  const parsed = await parseImageRequestJson(
    { model: "agnes-image-2.5-flash", prompt: "x" },
    "generations",
    { defaultSize: "2K", defaultResponseFormat: "b64_json" },
  );
  const payload = agnesPayload(parsed, "nested");
  assertEquals(payload.body.size, "2K");
  assertEquals("ratio" in payload.body, false);
});

Deno.test("normalizes an upstream URL response and fills the envelope", async () => {
  const request = await parse({
    model: "m",
    prompt: "p",
    size: "1024x1024",
    response_format: "url",
  });
  const normalized = normalizeAgnesResponse({
    created: 1,
    data: [{ url: "https://x/a.png", b64_json: "", revised_prompt: "" }],
  }, request);

  assertEquals(normalized.images, [
    { url: "https://x/a.png", b64_json: null, revised_prompt: null },
  ]);
  assertEquals(normalized.body.size, "1024x1024");
  assertEquals(normalized.body.output_format, "png");
  assertEquals(normalized.body.data, normalized.images);
  assertEquals(normalized.warnings, []);
});

Deno.test("warns when base64 was requested but the upstream returned a URL", async () => {
  const request = await parse({ model: "m", prompt: "p" });
  const normalized = normalizeAgnesResponse({
    created: 1,
    data: [{ url: "https://x/a.png" }],
  }, request);
  assertEquals(normalized.warnings.includes("upstream-returned-url"), true);
  assertEquals(normalized.images[0].b64_json, null);
});

Deno.test("missing data becomes a 502", async () => {
  const request = await parse({ model: "m", prompt: "p" });
  const error = assertThrows(() => normalizeAgnesResponse({ created: 1 }, request), ApiError);
  assertEquals(error.status, 502);
});

Deno.test("merges normalized responses", async () => {
  const request = await parse({ model: "m", prompt: "p" });
  const a = normalizeAgnesResponse({ created: 1, data: [{ b64_json: "AAA" }] }, request);
  const b = normalizeAgnesResponse({ created: 2, data: [{ b64_json: "BBB" }] }, request);
  const merged = mergeNormalizedResponses([a, b]);
  assertEquals((merged.body.data as unknown[]).length, 2);
  assertEquals(merged.warnings, []);
});
