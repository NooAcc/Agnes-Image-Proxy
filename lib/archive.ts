import { decodeBase64 } from "@std/encoding/base64";
import type { GalleryInsert, GalleryStore } from "./gallery.ts";
import { readImageDimensions } from "./image-dimensions.ts";
import { ARCHIVE_TIMEOUT_MS, MAX_ARCHIVE_BYTES } from "./limits.ts";
import type { NormalizedImage } from "./protocol.ts";
import { isPublicHttpsUrl } from "./remote-image.ts";
import { formatPixel } from "./size.ts";

export { isPublicHttpsUrl } from "./remote-image.ts";

export interface ArchiveRequest {
  ts: string;
  endpoint: string;
  model: string;
  accountId: number | null;
  accountName: string | null;
  prompt: string;
  size: string | null;
  tier: string | null;
  ratio: string | null;
  images: NormalizedImage[];
}

export interface Archiver {
  archive(request: ArchiveRequest): Promise<void>;
}

export interface ArchiverOptions {
  gallery: GalleryStore;
  fetchImpl?: typeof fetch;
  waitUntil?: (promise: Promise<unknown>) => void;
  maxBytes?: number;
  timeoutMs?: number;
}

const MAX_REDIRECTS = 2;

export function sniffImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function mimeFromUrl(url: string): string | null {
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  return null;
}

async function readBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength > maxBytes ? null : buffer;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function download(
  url: string,
  fetchImpl: typeof fetch,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (!isPublicHttpsUrl(current)) return null;

    let response: Response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      try {
        current = new URL(location, current).toString();
      } catch {
        return null;
      }
      continue;
    }

    if (!response.ok) return null;

    let bytes: Uint8Array | null;
    try {
      bytes = await readBody(response, maxBytes);
    } catch {
      return null;
    }
    if (bytes === null) return null;

    const sniffed = sniffImageMime(bytes);
    if (sniffed) return { bytes, mime: sniffed };
    const contentType = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
    if (contentType.startsWith("image/")) return { bytes, mime: contentType };
    return null;
  }
  return null;
}

export function createArchiver(options: ArchiverOptions): Archiver {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
  const timeoutMs = options.timeoutMs ?? ARCHIVE_TIMEOUT_MS;

  const persist = async (row: GalleryInsert): Promise<void> => {
    try {
      await options.gallery.record(row);
    } catch (error) {
      console.error("gallery write failed, falling back to source_url:", error);
      try {
        await options.gallery.record({ ...row, bytes: null });
      } catch (fallbackError) {
        console.error("gallery fallback write failed:", fallbackError);
      }
    }
  };

  const run = async (request: ArchiveRequest): Promise<void> => {
    const sizeFromBytes = (bytes: Uint8Array | null): string | null => {
      const dims = bytes ? readImageDimensions(bytes) : null;
      return dims ? formatPixel(dims) : request.size;
    };

    for (const image of request.images) {
      const base = {
        ts: request.ts,
        endpoint: request.endpoint,
        model: request.model,
        accountId: request.accountId,
        accountName: request.accountName,
        prompt: request.prompt,
        size: request.size,
        tier: request.tier,
        ratio: request.ratio,
      };

      if (image.b64_json) {
        let bytes: Uint8Array | null = null;
        let mime = "image/png";
        try {
          const decoded = decodeBase64(image.b64_json);
          if (decoded.byteLength > 0) {
            bytes = decoded;
            mime = sniffImageMime(decoded) ?? mime;
          }
        } catch {
          bytes = null;
        }
        await persist({ ...base, size: sizeFromBytes(bytes), mime, bytes, sourceUrl: null });
        continue;
      }

      if (image.url) {
        const downloaded = await download(image.url, fetchImpl, maxBytes, timeoutMs);
        const mime = downloaded?.mime ?? mimeFromUrl(image.url) ?? "image/png";
        await persist({
          ...base,
          size: sizeFromBytes(downloaded?.bytes ?? null),
          mime,
          bytes: downloaded?.bytes ?? null,
          sourceUrl: image.url,
        });
      }
    }
  };

  return {
    archive(request) {
      const task = run(request);
      if (options.waitUntil) {
        options.waitUntil(task);
        return Promise.resolve();
      }
      const edge = (globalThis as {
        EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
      }).EdgeRuntime;
      if (edge && typeof edge.waitUntil === "function") {
        edge.waitUntil(task);
        return Promise.resolve();
      }
      return task.then(() => {});
    },
  };
}
