import { assertEquals, assertThrows } from "@std/assert";
import { ApiError } from "../../lib/errors.ts";
import { formatPixel, formatRequestSize, resolveSize } from "../../lib/size.ts";

const cases = [
  [
    { size: "1024x1024" },
    {
      mode: "tier",
      tier: "1K",
      ratio: "1:1",
      derivedRatio: "1:1",
      pixel: { width: 1024, height: 1024 },
      requestedPixel: null,
    },
  ],
  [
    { size: "1536x1024" },
    {
      mode: "tier",
      tier: "1K",
      ratio: "3:2",
      derivedRatio: "3:2",
      pixel: { width: 1248, height: 832 },
      requestedPixel: null,
    },
  ],
  [
    { size: "1792x1024" },
    {
      mode: "tier",
      tier: "1K",
      ratio: "16:9",
      derivedRatio: "16:9",
      pixel: { width: 1312, height: 736 },
      requestedPixel: null,
    },
  ],
  [
    { size: "2560x1440" },
    {
      mode: "tier",
      tier: "2K",
      ratio: "16:9",
      derivedRatio: "16:9",
      pixel: { width: 2624, height: 1472 },
      requestedPixel: null,
    },
  ],
  [
    { size: "4096x4096" },
    {
      mode: "tier",
      tier: "4K",
      ratio: "1:1",
      derivedRatio: "1:1",
      pixel: { width: 4096, height: 4096 },
      requestedPixel: null,
    },
  ],
  [
    { size: "4K", ratio: "21:9" },
    {
      mode: "tier",
      tier: "4K",
      ratio: "21:9",
      derivedRatio: "21:9",
      pixel: { width: 6272, height: 2688 },
      requestedPixel: null,
    },
  ],
  [
    { size: "auto", reference: { width: 900, height: 1200 } },
    {
      mode: "exact",
      tier: "1K",
      ratio: null,
      derivedRatio: "3:4",
      pixel: { width: 864, height: 1152 },
      requestedPixel: { width: 900, height: 1200 },
    },
  ],
] as const;

for (const [input, expected] of cases) {
  Deno.test(`resolveSize ${JSON.stringify(input)}`, () =>
    assertEquals(resolveSize(input), expected));
}

Deno.test("resolveSize rejects an unknown ratio", () => {
  assertThrows(() => resolveSize({ size: "1K", ratio: "7:5" }), ApiError);
});

Deno.test("resolveSize rejects a malformed size", () => {
  const error = assertThrows(() => resolveSize({ size: "huge" }), ApiError);
  assertEquals(error.param, "size");
});

Deno.test("resolveSize defaults to a 1K tier without a ratio", () => {
  assertEquals(resolveSize({}), {
    mode: "tier",
    tier: "1K",
    ratio: null,
    derivedRatio: "1:1",
    pixel: { width: 1024, height: 1024 },
    requestedPixel: null,
  });
});

Deno.test("exact mode keeps the reference ratio for pixels when a ratio is sent", () => {
  assertEquals(
    resolveSize({ size: "auto", reference: { width: 900, height: 1200 }, ratio: "16:9" }),
    {
      mode: "exact",
      tier: "1K",
      ratio: "16:9",
      derivedRatio: "3:4",
      pixel: { width: 864, height: 1152 },
      requestedPixel: { width: 900, height: 1200 },
    },
  );
});

Deno.test("explicit ratio wins over the pixel-derived ratio", () => {
  assertEquals(resolveSize({ size: "1024x1024", ratio: "16:9" }), {
    mode: "tier",
    tier: "1K",
    ratio: "16:9",
    derivedRatio: "16:9",
    pixel: { width: 1312, height: 736 },
    requestedPixel: null,
  });
});

Deno.test("pixel sizes are mapped to the nearest tier without a cap", () => {
  assertEquals(resolveSize({ size: "8192x8192" }).tier, "4K");
  assertEquals(resolveSize({ size: "3000x3000" }).tier, "3K");
});

Deno.test("formatPixel renders WxH", () => {
  assertEquals(formatPixel({ width: 1024, height: 768 }), "1024x768");
});

Deno.test("formatRequestSize renders the request expression", () => {
  assertEquals(
    formatRequestSize(resolveSize({ size: "auto", reference: { width: 900, height: 1200 } })),
    "900x1200",
  );
  assertEquals(formatRequestSize(resolveSize({ size: "2K" })), "2K");
  assertEquals(formatRequestSize(resolveSize({ size: "1K", ratio: "16:9" })), "1K 16:9");
});
