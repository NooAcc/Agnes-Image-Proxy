import { assertEquals, assertRejects } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { ApiError } from "../../lib/errors.ts";
import { MAX_INPUT_IMAGE_BYTES, MAX_REQUEST_BYTES } from "../../lib/limits.ts";
import {
  agnesPayload,
  parseImageRequestJson,
  parseImageRequestMultipart,
} from "../../lib/protocol.ts";

const defaults = {
  defaultSize: "1K",
  defaultResponseFormat: "b64_json",
} as const;

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function multipart(fields: Record<string, string>, files: [string, File | string][]): Request {
  const form = new FormData();
  form.set("model", "agnes-image-2.5-flash");
  form.set("prompt", "edit this");
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  for (const [key, file] of files) {
    if (typeof file === "string") form.append(key, file);
    else form.append(key, file, file.name);
  }
  return new Request("https://x/v1/images/edits", { method: "POST", body: form });
}

function pngFile(name = "a.png", width = 2, height = 3): File {
  return new File([pngHeader(width, height) as unknown as BlobPart], name, { type: "image/png" });
}

Deno.test("multipart accepts a single image and the image[] key", async () => {
  const single = await parseImageRequestMultipart(
    multipart({}, [["image", pngFile()]]),
    defaults,
  );
  assertEquals(single.images.length, 1);
  assertEquals(single.images[0].startsWith("data:image/png;base64,"), true);
  assertEquals(single.endpoint, "edits");

  const bracketed = await parseImageRequestMultipart(
    multipart({}, [["image[]", pngFile()]]),
    defaults,
  );
  assertEquals(bracketed.images.length, 1);
});

Deno.test("multipart preserves the order of multiple files", async () => {
  const a = pngFile("a.png", 2, 3);
  const b = pngFile("b.png", 5, 7);
  const parsed = await parseImageRequestMultipart(
    multipart({}, [["image", a], ["image", b]]),
    defaults,
  );
  assertEquals(parsed.images.length, 2);
  assertEquals(
    parsed.images[0].includes(encodeBase64(new Uint8Array(await a.arrayBuffer()))),
    true,
  );
  assertEquals(
    parsed.images[1].includes(encodeBase64(new Uint8Array(await b.arrayBuffer()))),
    true,
  );
});

Deno.test("multipart rejects a mask, foreign MIME types and oversized files", async () => {
  const maskError = await assertRejects(
    () =>
      parseImageRequestMultipart(
        multipart({}, [["image", pngFile()], ["mask", pngFile()]]),
        defaults,
      ),
    ApiError,
  );
  assertEquals(maskError.code, "unsupported_parameter");
  assertEquals(maskError.param, "mask");

  const textFile = new File(["hello"], "a.txt", { type: "text/plain" });
  const mimeError = await assertRejects(
    () => parseImageRequestMultipart(multipart({}, [["image", textFile]]), defaults),
    ApiError,
  );
  assertEquals(mimeError.status, 400);

  const huge = new File(
    [new Uint8Array(MAX_INPUT_IMAGE_BYTES + 1) as unknown as BlobPart],
    "big.png",
    {
      type: "image/png",
    },
  );
  const sizeError = await assertRejects(
    () => parseImageRequestMultipart(multipart({}, [["image", huge]]), defaults),
    ApiError,
  );
  assertEquals(sizeError.status, 400);
});

Deno.test("multipart rejects an oversized declared body with 413", async () => {
  const request = new Request("https://x/v1/images/edits", {
    method: "POST",
    headers: { "content-length": String(MAX_REQUEST_BYTES + 1) },
  });
  const error = await assertRejects(() => parseImageRequestMultipart(request, defaults), ApiError);
  assertEquals(error.status, 413);
});

Deno.test("multipart rejects a cumulative body over the limit", async () => {
  const chunk = new Uint8Array(2.1 * 1024 * 1024);
  const files: [string, File][] = [];
  for (let i = 0; i < 16; i++) {
    files.push([
      "image",
      new File([chunk as unknown as BlobPart], `f${i}.png`, { type: "image/png" }),
    ]);
  }
  const error = await assertRejects(
    () => parseImageRequestMultipart(multipart({}, files), defaults),
    ApiError,
  );
  assertEquals(error.status, 413);
});

Deno.test("auto size uses the first file's real dimensions", async () => {
  const parsed = await parseImageRequestMultipart(
    multipart({ size: "auto" }, [["image", pngFile("a.png", 2, 3)]]),
    defaults,
  );
  assertEquals(parsed.size.mode, "exact");
  assertEquals(parsed.size.tier, "1K");
  assertEquals(parsed.size.ratio, null);
  assertEquals(parsed.size.derivedRatio, "2:3");
  assertEquals(parsed.size.requestedPixel, { width: 2, height: 3 });
  const payload = agnesPayload(parsed, "nested");
  assertEquals(payload.body.size, "2x3");
  assertEquals("ratio" in payload.body, false);
});

Deno.test("multipart omitted size uses the first file's real dimensions", async () => {
  const parsed = await parseImageRequestMultipart(
    multipart({}, [["image", pngFile("a.png", 900, 1200)]]),
    defaults,
  );
  const payload = agnesPayload(parsed, "nested");
  assertEquals(payload.body.size, "900x1200");
  assertEquals("ratio" in payload.body, false);
});

Deno.test("auto with a URL reference fetches the first URL only", async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls++;
    return Promise.resolve(
      new Response(pngHeader(900, 1200) as unknown as BodyInit),
    );
  };
  const parsed = await parseImageRequestJson(
    {
      model: "agnes-image-2.5-flash",
      prompt: "p",
      size: "auto",
      images: [{ image_url: "https://a.example/1.png" }, {
        image_url: "https://a.example/2.png",
      }],
    },
    "edits",
    defaults,
    undefined,
    { fetchImpl },
  );
  assertEquals(agnesPayload(parsed, "nested").body.size, "900x1200");
  assertEquals(calls, 1);
});

Deno.test("an unreadable reference URL fails with a 400", async () => {
  const fetchImpl = () => Promise.reject(new Error("boom"));
  const error = await assertRejects(
    () =>
      parseImageRequestJson(
        {
          model: "agnes-image-2.5-flash",
          prompt: "p",
          size: "auto",
          images: [{ image_url: "https://a.example/x.png" }],
        },
        "edits",
        defaults,
        undefined,
        { fetchImpl },
      ),
    ApiError,
  );
  assertEquals(error.status, 400);
});

Deno.test("JSON edits accept a mix of image URLs and data URIs", async () => {
  const parsed = await parseImageRequestJson(
    {
      model: "m",
      prompt: "p",
      size: "1K",
      images: [
        { image_url: "https://example.com/a.png" },
        { image_url: "data:image/png;base64,AAAA" },
      ],
    },
    "edits",
    defaults,
  );
  assertEquals(parsed.images, [
    "https://example.com/a.png",
    "data:image/png;base64,AAAA",
  ]);
});

Deno.test("JSON edits reject file_id and normalize extra_body.image", async () => {
  const fileIdError = await assertRejects(
    () =>
      parseImageRequestJson(
        {
          model: "m",
          prompt: "p",
          images: [{ file_id: "file-1" }],
        },
        "edits",
        defaults,
      ),
    ApiError,
  );
  assertEquals(fileIdError.code, "unsupported_parameter");

  const viaExtraBody = await parseImageRequestJson(
    {
      model: "m",
      prompt: "p",
      size: "1K",
      extra_body: { image: ["https://example.com/a.png"] },
    },
    "edits",
    defaults,
  );
  assertEquals(viaExtraBody.images, ["https://example.com/a.png"]);

  const single = await parseImageRequestJson(
    {
      model: "m",
      prompt: "p",
      size: "1K",
      image: "https://example.com/a.png",
    },
    "edits",
    defaults,
  );
  assertEquals(single.images, ["https://example.com/a.png"]);
});

Deno.test("JSON edits reject non-http(s) image references", async () => {
  const error = await assertRejects(
    () =>
      parseImageRequestJson(
        {
          model: "m",
          prompt: "p",
          images: [{ image_url: "ftp://example.com/a.png" }],
        },
        "edits",
        defaults,
      ),
    ApiError,
  );
  assertEquals(error.status, 400);
});

Deno.test("payload placement follows the nested and top_level modes", async () => {
  const parsed = await parseImageRequestJson(
    {
      model: "m",
      prompt: "p",
      size: "1024x1024",
      images: ["https://example.com/a.png"],
    },
    "edits",
    defaults,
  );

  const nested = agnesPayload(parsed, "nested");
  assertEquals(nested.body.image, undefined);
  assertEquals(nested.body.extra_body, {
    image: ["https://example.com/a.png"],
    response_format: "b64_json",
  });

  const topLevel = agnesPayload(parsed, "top_level");
  assertEquals(topLevel.body.image, ["https://example.com/a.png"]);
  assertEquals((topLevel.body.extra_body as Record<string, unknown>).image, undefined);
  assertEquals((topLevel.body.extra_body as Record<string, unknown>).response_format, "b64_json");
});

Deno.test("auto size uses a JSON data URI reference as exact pixels", async () => {
  const dataUri = `data:image/png;base64,${encodeBase64(pngHeader(2, 3))}`;
  const parsed = await parseImageRequestJson(
    {
      model: "m",
      prompt: "p",
      size: "auto",
      images: [{ image_url: dataUri }],
    },
    "edits",
    defaults,
  );
  assertEquals(parsed.size.mode, "exact");
  assertEquals(parsed.size.requestedPixel, { width: 2, height: 3 });
  assertEquals(parsed.size.derivedRatio, "2:3");
  assertEquals(parsed.size.ratio, null);
  const payload = agnesPayload(parsed, "nested");
  assertEquals(payload.body.size, "2x3");
  assertEquals("ratio" in payload.body, false);
});

Deno.test("multipart auto with a URL reference fetches the first URL only", async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls++;
    return Promise.resolve(new Response(pngHeader(900, 1200) as unknown as BodyInit));
  };
  const parsed = await parseImageRequestMultipart(
    multipart({ size: "auto" }, [
      ["image", "https://a.example/1.png"],
      ["image", "https://a.example/2.png"],
    ]),
    defaults,
    { fetchImpl },
  );
  assertEquals(agnesPayload(parsed, "nested").body.size, "900x1200");
  assertEquals(calls, 1);
});

Deno.test("multipart auto size reads a data URI field", async () => {
  const dataUri = `data:image/png;base64,${encodeBase64(pngHeader(2, 3))}`;
  const form = new FormData();
  form.set("model", "m");
  form.set("prompt", "p");
  form.set("size", "auto");
  form.set("image", dataUri);
  const request = new Request("https://x/v1/images/edits", { method: "POST", body: form });
  const parsed = await parseImageRequestMultipart(request, defaults);
  assertEquals(parsed.size.mode, "exact");
  assertEquals(parsed.size.requestedPixel, { width: 2, height: 3 });
  assertEquals(parsed.size.derivedRatio, "2:3");
});
