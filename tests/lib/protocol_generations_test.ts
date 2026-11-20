import { assertEquals, assertThrows } from "@std/assert";
import { ApiError } from "../../lib/errors.ts";
import {
  agnesPayload,
  mergeNormalizedResponses,
  normalizeAgnesResponse,
  parseImageRequestJson,
} from "../../lib/protocol.ts";

const defaults = {
  defaultSize: "1K",
  defaultRatio: "1:1",
  defaultResponseFormat: "b64_json",
} as const;

function parse(raw: unknown) {
  return parseImageRequestJson(raw, "generations", defaults);
}

Deno.test("parses the minimal generation request", () => {
  const request = parse({ model: "agnes-image-2.5-flash", prompt: "x", size: "1024x1024" });
  assertEquals(request.n, 1);
  assertEquals(request.size.tier, "1K");
  assertEquals(request.size.ratio, "1:1");
  assertEquals(request.responseFormat, "b64_json");
  assertEquals(request.images, []);
  assertEquals(request.warnings, []);
});

Deno.test("response_format and return_base64 select the response format", () => {
  assertEquals(parse({ model: "m", prompt: "p", response_format: "url" }).responseFormat, "url");
  assertEquals(parse({ model: "m", prompt: "p", return_base64: false }).responseFormat, "url");
  assertEquals(parse({ model: "m", prompt: "p", return_base64: true }).responseFormat, "b64_json");
});

Deno.test("n must be a positive integer without an upper cap", () => {
  for (const n of [0, 1.5, "3", -1]) {
    const error = assertThrows(() => parse({ model: "m", prompt: "p", n }), ApiError);
    assertEquals(error.status, 400);
  }
  assertEquals(parse({ model: "m", prompt: "p", n: 5 }).n, 5);
  assertEquals(parse({ model: "m", prompt: "p", n: 25 }).n, 25);
});

Deno.test("unsupported and unknown fields become warnings", () => {
  const request = parse({
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

Deno.test("extra_body is preserved", () => {
  const request = parse({ model: "m", prompt: "p", extra_body: { foo: 1 } });
  assertEquals(request.extraBody.foo, 1);
});

Deno.test("model and prompt are required", () => {
  assertThrows(() => parse({ prompt: "p" }), ApiError);
  assertThrows(() => parse({ model: "m" }), ApiError);
  assertThrows(() => parse({ model: "m", prompt: "  " }), ApiError);
});

Deno.test("stream and partial_images are rejected", () => {
  const streamError = assertThrows(
    () => parse({ model: "m", prompt: "p", stream: true }),
    ApiError,
  );
  assertEquals(streamError.param, "stream");
  assertEquals(streamError.code, "unsupported_parameter");
  assertThrows(() => parse({ model: "m", prompt: "p", partial_images: 2 }), ApiError);
});

Deno.test("tier payload requests base64 at the top level", () => {
  const payload = agnesPayload(parse({ model: "m", prompt: "p", size: "1024x1024" }), "nested");
  assertEquals(payload.path, "/images/generations");
  assertEquals(payload.body, {
    model: "m",
    prompt: "p",
    size: "1K",
    ratio: "1:1",
    return_base64: true,
  });
});

Deno.test("exact models receive pixel sizes without a ratio", () => {
  const payload = agnesPayload(
    parse({ model: "agnes-image-2.0-flash", prompt: "p", size: "1024x1024" }),
    "nested",
  );
  assertEquals(payload.body, {
    model: "agnes-image-2.0-flash",
    prompt: "p",
    size: "1024x1024",
    return_base64: true,
  });
});

Deno.test("url responses move response_format into extra_body", () => {
  const payload = agnesPayload(
    parse({ model: "m", prompt: "p", size: "1024x1024", response_format: "url" }),
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

Deno.test("extra_body keys are merged without duplicating consumed ones", () => {
  const payload = agnesPayload(
    parse({ model: "m", prompt: "p", extra_body: { foo: 1, return_base64: false } }),
    "nested",
  );
  assertEquals(payload.body.extra_body, { foo: 1 });
});

Deno.test("normalizes an upstream URL response and fills the envelope", () => {
  const request = parse({ model: "m", prompt: "p", size: "1024x1024", response_format: "url" });
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

Deno.test("warns when base64 was requested but the upstream returned a URL", () => {
  const request = parse({ model: "m", prompt: "p" });
  const normalized = normalizeAgnesResponse({
    created: 1,
    data: [{ url: "https://x/a.png" }],
  }, request);
  assertEquals(normalized.warnings.includes("upstream-returned-url"), true);
  assertEquals(normalized.images[0].b64_json, null);
});

Deno.test("missing data becomes a 502", () => {
  const request = parse({ model: "m", prompt: "p" });
  const error = assertThrows(() => normalizeAgnesResponse({ created: 1 }, request), ApiError);
  assertEquals(error.status, 502);
});

Deno.test("merges normalized responses", () => {
  const request = parse({ model: "m", prompt: "p" });
  const a = normalizeAgnesResponse({ created: 1, data: [{ b64_json: "AAA" }] }, request);
  const b = normalizeAgnesResponse({ created: 2, data: [{ b64_json: "BBB" }] }, request);
  const merged = mergeNormalizedResponses([a, b]);
  assertEquals((merged.body.data as unknown[]).length, 2);
  assertEquals(merged.warnings, []);
});
