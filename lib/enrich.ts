import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import type { EnrichInput, EnrichmentWrite, GalleryStore, NsfwScores } from "./gallery.ts";
import { sniffImageMime } from "./image-mime.ts";
import {
  IMAGE_SERVICE_BATCH_SOURCE_BYTES,
  IMAGE_SERVICE_MAX_ITEMS,
  IMAGE_SERVICE_MAX_SOURCE_BYTES,
} from "./limits.ts";
import type { SettingsStore } from "./settings.ts";

/** Fixed preference order used to break nsfw-detection-2-mini ties (earlier wins). */
export const NSFW_TAG_ORDER = ["safe", "drawing", "sexy", "porn", "hentai"] as const;
export type NsfwTag = typeof NSFW_TAG_ORDER[number];

export interface EnrichReport {
  processed: number;
  succeeded: number;
  failed: number;
}

export interface Enricher {
  enabled(): Promise<boolean>;
  enrich(rows: EnrichInput[]): Promise<EnrichReport>;
}

export interface EnricherOptions {
  settings: SettingsStore;
  gallery: Pick<GalleryStore, "setEnrichment">;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxSourceBytes?: number;
}

const ERROR_MAX_LENGTH = 200;

function truncateError(message: string): string {
  return message.length > ERROR_MAX_LENGTH ? message.slice(0, ERROR_MAX_LENGTH) : message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyReport(): EnrichReport {
  return { processed: 0, succeeded: 0, failed: 0 };
}

export function tagForNsfw(scores: NsfwScores): NsfwTag {
  let tag: NsfwTag = NSFW_TAG_ORDER[0];
  for (const candidate of NSFW_TAG_ORDER) {
    if (scores[candidate] > scores[tag]) tag = candidate;
  }
  return tag;
}

/**
 * Splits rows into batches bounded by both item count and cumulative source bytes.
 * A single row over maxBytes still forms its own batch so callers can handle it.
 */
export function chunkByBudget<T extends { bytes: Uint8Array }>(
  rows: T[],
  maxItems: number,
  maxBytes: number,
): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let sum = 0;
  for (const row of rows) {
    const size = row.bytes.byteLength;
    if (chunk.length > 0 && (chunk.length >= maxItems || sum + size > maxBytes)) {
      chunks.push(chunk);
      chunk = [];
      sum = 0;
    }
    chunk.push(row);
    sum += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function isNsfwScores(value: unknown): value is NsfwScores {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  for (const tag of NSFW_TAG_ORDER) {
    const score = record[tag];
    if (typeof score !== "number" || !Number.isFinite(score)) return false;
  }
  return typeof record.isNsfw === "boolean";
}

interface BatchItem {
  uuid: string;
  base64: string;
  contentType: string;
  params: {
    width: number;
    height: number;
    crop: "none";
    size: "down";
    format: "webp";
    quality: number;
    nsfw: 1;
  };
}

export function createEnricher(options: EnricherOptions): Enricher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const maxSourceBytes = options.maxSourceBytes ?? IMAGE_SERVICE_MAX_SOURCE_BYTES;

  async function writeFailed(id: number, at: string, message: string): Promise<void> {
    const input: EnrichmentWrite = {
      thumb: null,
      thumbMime: null,
      nsfw: null,
      tag: null,
      status: "failed",
      error: truncateError(message),
      at,
    };
    try {
      await options.gallery.setEnrichment(id, input);
    } catch (error) {
      console.error("image enrichment write failed:", error);
    }
  }

  async function writeSucceeded(
    id: number,
    at: string,
    scores: NsfwScores,
    thumb: Uint8Array | null,
    thumbMime: string | null,
  ): Promise<boolean> {
    try {
      await options.gallery.setEnrichment(id, {
        thumb,
        thumbMime,
        nsfw: scores,
        tag: tagForNsfw(scores),
        status: "ok",
        error: null,
        at,
      });
      return true;
    } catch (error) {
      console.error("image enrichment write failed:", error);
      return false;
    }
  }

  return {
    async enabled() {
      const settings = await options.settings.read();
      return settings.imageServiceBaseUrl !== "";
    },

    async enrich(rows) {
      const report = emptyReport();
      if (rows.length === 0) return report;

      const settings = await options.settings.read();
      const baseUrl = settings.imageServiceBaseUrl;
      if (baseUrl === "") return report;

      const at = now().toISOString();
      const eligible: EnrichInput[] = [];
      for (const row of rows) {
        if (row.bytes.byteLength > maxSourceBytes) {
          report.processed++;
          report.failed++;
          await writeFailed(row.id, at, "source exceeds 50 MiB");
          continue;
        }
        eligible.push(row);
      }

      const chunks = chunkByBudget(
        eligible,
        IMAGE_SERVICE_MAX_ITEMS,
        IMAGE_SERVICE_BATCH_SOURCE_BYTES,
      );

      for (const chunk of chunks) {
        report.processed += chunk.length;
        const items: BatchItem[] = chunk.map((row) => ({
          uuid: String(row.id),
          base64: encodeBase64(row.bytes),
          contentType: row.mime,
          params: {
            width: settings.thumbnailWidth,
            height: settings.thumbnailWidth,
            crop: "none",
            size: "down",
            format: "webp",
            quality: settings.thumbnailQuality,
            nsfw: 1,
          },
        }));

        let payload: Record<string, unknown> | null = null;
        let batchError = "";
        try {
          const response = await fetchImpl(`${baseUrl}/api/batch`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(items),
            signal: AbortSignal.timeout(settings.enrichTimeoutMs),
          });
          if (!response.ok) {
            batchError = `image service responded ${response.status}`;
          } else {
            const parsed: unknown = await response.json();
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              payload = parsed as Record<string, unknown>;
            } else {
              batchError = "image service returned an invalid response";
            }
          }
        } catch (error) {
          batchError = errorMessage(error);
        }

        for (const row of chunk) {
          if (payload === null) {
            report.failed++;
            await writeFailed(row.id, at, batchError);
            continue;
          }

          const entry = payload[String(row.id)];
          if (typeof entry !== "object" || entry === null) {
            report.failed++;
            await writeFailed(row.id, at, "image service returned no result");
            continue;
          }
          const item = entry as { success?: unknown; error?: unknown; data?: unknown };

          if (item.success !== true) {
            const message = typeof item.error === "string" && item.error !== ""
              ? item.error
              : "image service item failed";
            report.failed++;
            await writeFailed(row.id, at, message);
            continue;
          }

          const data = item.data;
          if (typeof data !== "object" || data === null) {
            report.failed++;
            await writeFailed(row.id, at, "nsfw: prediction unavailable");
            continue;
          }
          const result = data as { base64?: unknown; nsfw?: unknown };
          if (!isNsfwScores(result.nsfw)) {
            report.failed++;
            await writeFailed(row.id, at, "nsfw: prediction unavailable");
            continue;
          }

          let thumb: Uint8Array | null = null;
          let thumbMime: string | null = null;
          if (typeof result.base64 === "string" && result.base64 !== "") {
            try {
              const decoded = decodeBase64(result.base64);
              const mime = sniffImageMime(decoded);
              if (mime !== null && decoded.byteLength < row.bytes.byteLength) {
                thumb = decoded;
                thumbMime = mime;
              }
            } catch {
              // Keep the tag without a thumbnail when decoding fails.
            }
          }

          const wrote = await writeSucceeded(row.id, at, result.nsfw, thumb, thumbMime);
          if (wrote) report.succeeded++;
          else report.failed++;
        }
      }

      return report;
    },
  };
}
