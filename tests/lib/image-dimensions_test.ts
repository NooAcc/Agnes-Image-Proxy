import { assertEquals } from "@std/assert";
import { readImageDimensions } from "../../lib/image-dimensions.ts";

function writeU32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function writeU24LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  writeU32BE(bytes, 8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  writeU32BE(bytes, 16, width);
  writeU32BE(bytes, 20, height);
  return bytes;
}

Deno.test("reads PNG IHDR dimensions", () => {
  assertEquals(readImageDimensions(pngHeader(2, 3)), { width: 2, height: 3 });
});

Deno.test("reads JPEG SOF0 dimensions", () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x02]);
  assertEquals(readImageDimensions(bytes), { width: 2, height: 3 });
});

Deno.test("skips JPEG APP markers before the SOF marker", () => {
  const bytes = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x00,
    0x03,
    0x00,
    0x02,
  ]);
  assertEquals(readImageDimensions(bytes), { width: 2, height: 3 });
});

Deno.test("reads WebP VP8X canvas dimensions", () => {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x16, 0x00, 0x00, 0x00], 4); // size
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  bytes.set([0x0a, 0x00, 0x00, 0x00], 16); // chunk size
  bytes[20] = 0x10;
  writeU24LE(bytes, 24, 127); // width - 1
  writeU24LE(bytes, 27, 95); // height - 1
  assertEquals(readImageDimensions(bytes), { width: 128, height: 96 });
});

Deno.test("reads WebP VP8L lossless dimensions", () => {
  const bytes = new Uint8Array(25);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x11, 0x00, 0x00, 0x00], 4);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12);
  bytes.set([0x05, 0x00, 0x00, 0x00], 16);
  bytes[20] = 0x2f;
  const packed = (127) | (95 << 14);
  bytes[21] = packed & 0xff;
  bytes[22] = (packed >>> 8) & 0xff;
  bytes[23] = (packed >>> 16) & 0xff;
  bytes[24] = (packed >>> 24) & 0xff;
  assertEquals(readImageDimensions(bytes), { width: 128, height: 96 });
});

Deno.test("returns null for garbage and truncated data", () => {
  assertEquals(readImageDimensions(new Uint8Array([1, 2, 3])), null);
  assertEquals(readImageDimensions(pngHeader(2, 3).slice(0, 20)), null);
});
