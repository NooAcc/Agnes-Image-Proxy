import { decodeBase64 } from "@std/encoding/base64";
import type { Enricher } from "./enrich.ts";
import type { EnrichInput, GalleryInsert, GalleryStore } from "./gallery.ts";
import { sniffImageMime } from "./image-mime.ts";
import { ARCHIVE_TIMEOUT_MS, MAX_ARCHIVE_BYTES } from "./limits.ts";
import { recordEnrichmentLog, type RequestLogStore } from "./logs.ts";
import type { NormalizedImage } from "./protocol.ts";
import { isPublicHttpsUrl } from "./remote-image.ts";
import { formatPixel, type PixelSize } from "./size.ts";

export { isPublicHttpsUrl } from "./remote-image.ts";
export { sniffImageMime } from "./image-mime.ts";

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
  sizes: (PixelSize | null)[];
}

export interface Archiver {
  archive(request: ArchiveRequest): Promise<void>;
}

export interface ArchiverOptions {
  gallery: GalleryStore;
  enricher?: Enricher;
  logs?: RequestLogStore;
  fetchImpl?: typeof fetch;
  waitUntil?: (promise: Promise<unknown>) => void;
  maxBytes?: number;
  timeoutMs?: number;
  now?: () => Date;
}

const MAX_REDIRECTS = 2;

interface PersistedRow {
  id: number;
  bytes: Uint8Array | null;
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
    return null;
  }
  return null;
}

export function createArchiver(options: ArchiverOptions): Archiver {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
  const timeoutMs = options.timeoutMs ?? ARCHIVE_TIMEOUT_MS;

  const persist = async (row: GalleryInsert): Promise<PersistedRow | null> => {
    try {
      const id = await options.gallery.record(row);
      return { id, bytes: row.bytes };
    } catch (error) {
      console.error("gallery write failed, falling back to source_url:", error);
      try {
        const id = await options.gallery.record({ ...row, bytes: null });
        return { id, bytes: null };
      } catch (fallbackError) {
        console.error("gallery fallback write failed:", fallbackError);
        return null;
      }
    }
  };

  const run = async (request: ArchiveRequest): Promise<void> => {
    const enrichable: EnrichInput[] = [];

    for (const [index, image] of request.images.entries()) {
      const measured = request.sizes[index] ?? null;
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
        let mime = "application/octet-stream";
        try {
          const decoded = decodeBase64(image.b64_json);
          const sniffed = decoded.byteLength > 0 ? sniffImageMime(decoded) : null;
          if (sniffed) {
            bytes = decoded;
            mime = sniffed;
          }
        } catch {
          bytes = null;
        }
        const persisted = await persist({
          ...base,
          size: measured ? formatPixel(measured) : request.size,
          mime,
          bytes,
          sourceUrl: null,
        });
        if (persisted) {
          const enrichBytes = persisted.bytes ?? bytes;
          if (image.url !== null || enrichBytes !== null) {
            enrichable.push({
              id: persisted.id,
              mime,
              url: image.url,
              bytes: enrichBytes,
              sourceBytes: enrichBytes?.byteLength ?? 0,
            });
          }
        }
        continue;
      }

      if (image.url) {
        const downloaded = await download(image.url, fetchImpl, maxBytes, timeoutMs);
        const mime = downloaded?.mime ?? "application/octet-stream";
        const persisted = await persist({
          ...base,
          size: measured ? formatPixel(measured) : request.size,
          mime,
          bytes: downloaded?.bytes ?? null,
          sourceUrl: image.url,
        });
        if (persisted) {
          const enrichBytes = persisted.bytes ?? downloaded?.bytes ?? null;
          if (image.url !== null || enrichBytes !== null) {
            enrichable.push({
              id: persisted.id,
              mime,
              url: image.url,
              bytes: enrichBytes,
              sourceBytes: enrichBytes?.byteLength ?? 0,
            });
          }
        }
      }
    }

    if (options.enricher && enrichable.length > 0) {
      const startedAt = Date.now();
      const at = options.now ? options.now() : new Date();
      try {
        const report = await options.enricher.enrich(enrichable);
        if (options.logs) {
          await recordEnrichmentLog(options.logs, {
            ts: at.toISOString(),
            endpoint: "archive/enrich",
            path: null,
            requested: report.processed,
            succeeded: report.succeeded,
            failed: report.failed,
            durationMs: Date.now() - startedAt,
          });
        }
      } catch (error) {
        console.error("image enrichment failed:", error);
        if (options.logs) {
          await recordEnrichmentLog(options.logs, {
            ts: at.toISOString(),
            endpoint: "archive/enrich",
            path: null,
            requested: enrichable.length,
            succeeded: 0,
            failed: enrichable.length,
            durationMs: Date.now() - startedAt,
          });
        }
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
