export interface ImageDimensions {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset + expected.length > bytes.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function readU16BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>> 0;
}

function readU16LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU24LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 3 > bytes.length) return null;
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readU32LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>> 0;
}

function readPng(bytes: Uint8Array): ImageDimensions | null {
  if (!hasBytes(bytes, 0, PNG_SIGNATURE)) return null;
  if (!hasBytes(bytes, 12, [0x49, 0x48, 0x44, 0x52])) return null; // IHDR
  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  if (width === null || height === null || width === 0 || height === 0) return null;
  return { width, height };
}

const SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);

function readJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (!hasBytes(bytes, 0, [0xff, 0xd8])) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = readU16BE(bytes, offset + 2);
    if (length === null || length < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      const height = readU16BE(bytes, offset + 5);
      const width = readU16BE(bytes, offset + 7);
      if (height === null || width === null || height === 0 || width === 0) return null;
      return { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

function readWebp(bytes: Uint8Array): ImageDimensions | null {
  if (!hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46])) return null; // RIFF
  if (!hasBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return null; // WEBP
  const chunk = bytes.subarray(12, 16);
  const id = String.fromCharCode(...chunk);

  if (id === "VP8X") {
    const width = readU24LE(bytes, 24);
    const height = readU24LE(bytes, 27);
    if (width === null || height === null) return null;
    return { width: width + 1, height: height + 1 };
  }

  if (id === "VP8 ") {
    // frame tag (3 bytes) + start code (3 bytes) + 16-bit width/height
    if (!hasBytes(bytes, 23, [0x9d, 0x01, 0x2a])) return null;
    const width = readU16LE(bytes, 26);
    const height = readU16LE(bytes, 28);
    if (width === null || height === null) return null;
    return { width: width & 0x3fff, height: height & 0x3fff };
  }

  if (id === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const packed = readU32LE(bytes, 21);
    if (packed === null) return null;
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }

  return null;
}

/**
 * Reads image dimensions from PNG, JPEG or WebP headers without decoding.
 * Returns null when the format is unknown or the header is truncated.
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 3) return null;
  if (bytes[0] === 0x89) return readPng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return readJpeg(bytes);
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46) return readWebp(bytes);
  return null;
}
