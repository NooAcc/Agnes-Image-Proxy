import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import type { EnrichInput, EnrichmentWrite, GalleryStore, NsfwScores } from "./gallery.ts";
import { isAllowedImageMime, sniffImageMime } from "./image-mime.ts";
import {
  type ImageServiceBatchResult,
  type ImageServiceItem,
  postImageServiceBatch,
} from "./image-service.ts";
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

function chunkByCost<T>(
  rows: T[],
  maxItems: number,
  maxBytes: number,
  cost: (row: T) => number,
): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let sum = 0;
  for (const row of rows) {
    const size = cost(row);
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

/** URL rows cost nothing; only inline base64 counts against the byte budget. */
export function chunkEnrichInputs(
  rows: EnrichInput[],
  maxItems: number,
  maxBytes: number,
): EnrichInput[][] {
  return chunkByCost(
    rows,
    maxItems,
    maxBytes,
    (row) => row.url !== null ? 0 : row.bytes?.byteLength ?? 0,
  );
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

function itemFor(row: EnrichInput, params: Record<string, unknown>): ImageServiceItem {
  if (row.url !== null) return { uuid: String(row.id), url: row.url, params };
  return {
    uuid: String(row.id),
    base64: encodeBase64(row.bytes as Uint8Array),
    contentType: row.mime,
    params,
  };
}

interface EnrichOk {
  status: "ok";
  scores: NsfwScores;
  thumb: Uint8Array | null;
  thumbMime: string | null;
}

interface EnrichFailure {
  status: "failed";
  error: string;
  /** Only an item-level URL failure may be retried as base64. */
  retryable: boolean;
}

type EnrichOutcome = EnrichOk | EnrichFailure;

function outcomeFor(row: EnrichInput, batch: ImageServiceBatchResult): EnrichOutcome {
  if (!batch.ok) {
    return {
      status: "failed",
      error: batch.error ?? "image service request failed",
      retryable: false,
    };
  }

  const entry = batch.results[String(row.id)];
  if (typeof entry !== "object" || entry === null) {
    return { status: "failed", error: "image service returned no result", retryable: false };
  }
  const item = entry as { success?: unknown; error?: unknown; data?: unknown };
  if (item.success !== true) {
    return {
      status: "failed",
      error: typeof item.error === "string" && item.error !== ""
        ? item.error
        : "image service item failed",
      retryable: true,
    };
  }

  const data = item.data;
  if (typeof data !== "object" || data === null) {
    return { status: "failed", error: "nsfw: prediction unavailable", retryable: false };
  }
  const result = data as { base64?: unknown; contentType?: unknown; nsfw?: unknown };
  if (!isNsfwScores(result.nsfw)) {
    return { status: "failed", error: "nsfw: prediction unavailable", retryable: false };
  }

  let thumb: Uint8Array | null = null;
  let thumbMime: string | null = null;
  if (typeof result.base64 === "string" && result.base64 !== "") {
    try {
      const decoded = decodeBase64(result.base64);
      const declared = typeof result.contentType === "string" &&
          isAllowedImageMime(result.contentType)
        ? result.contentType
        : sniffImageMime(decoded);
      if (declared !== null && (row.sourceBytes === 0 || decoded.byteLength < row.sourceBytes)) {
        thumb = decoded;
        thumbMime = declared;
      }
    } catch {
      // Keep the tag without a thumbnail when decoding fails.
    }
  }

  return { status: "ok", scores: result.nsfw, thumb, thumbMime };
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
      const params = {
        width: settings.thumbnailWidth,
        height: settings.thumbnailWidth,
        crop: "none",
        size: "down",
        format: "webp",
        quality: settings.thumbnailQuality,
        nsfw: 1,
      };
      const outcomes = new Map<number, EnrichOutcome>();
      const eligible: EnrichInput[] = [];
      for (const row of rows) {
        if (row.url === null && (row.bytes === null || row.bytes.byteLength > maxSourceBytes)) {
          report.processed++;
          report.failed++;
          await writeFailed(
            row.id,
            at,
            row.bytes === null ? "no image source" : "source exceeds 50 MiB",
          );
          continue;
        }
        eligible.push(row);
      }

      const request = async (chunk: EnrichInput[], items: ImageServiceItem[]): Promise<void> => {
        const batch = await postImageServiceBatch(items, {
          baseUrl,
          timeoutMs: settings.enrichTimeoutMs,
          fetchImpl,
        });
        for (const row of chunk) outcomes.set(row.id, outcomeFor(row, batch));
      };

      for (
        const chunk of chunkEnrichInputs(
          eligible,
          IMAGE_SERVICE_MAX_ITEMS,
          IMAGE_SERVICE_BATCH_SOURCE_BYTES,
        )
      ) {
        report.processed += chunk.length;
        await request(chunk, chunk.map((row) => itemFor(row, params)));
      }

      // A failed URL item retries once as base64 when a local copy is available.
      const retryRows = eligible.filter(
        (row): row is EnrichInput & { bytes: Uint8Array } => {
          const outcome = outcomes.get(row.id);
          return outcome?.status === "failed" &&
            outcome.retryable &&
            row.url !== null &&
            row.bytes !== null &&
            row.bytes.byteLength <= maxSourceBytes;
        },
      );
      for (
        const chunk of chunkByBudget(
          retryRows,
          IMAGE_SERVICE_MAX_ITEMS,
          IMAGE_SERVICE_BATCH_SOURCE_BYTES,
        )
      ) {
        await request(
          chunk,
          chunk.map((row) => ({
            uuid: String(row.id),
            base64: encodeBase64(row.bytes),
            contentType: row.mime,
            params,
          })),
        );
      }

      for (const row of eligible) {
        const outcome = outcomes.get(row.id);
        if (!outcome) continue;
        if (outcome.status === "ok") {
          const wrote = await writeSucceeded(
            row.id,
            at,
            outcome.scores,
            outcome.thumb,
            outcome.thumbMime,
          );
          if (wrote) report.succeeded++;
          else report.failed++;
        } else {
          report.failed++;
          await writeFailed(row.id, at, outcome.error);
        }
      }

      return report;
    },
  };
}
