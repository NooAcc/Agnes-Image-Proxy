import { type ImageServiceItem, postImageServiceBatch } from "./image-service.ts";
import { IMAGE_SERVICE_MAX_ITEMS, IMAGE_SERVICE_META_TIMEOUT_MS } from "./limits.ts";
import type { NormalizedImage } from "./protocol.ts";
import type { PixelSize } from "./size.ts";

export interface MeasuredOutputs {
  sizes: (PixelSize | null)[];
  formats: (string | null)[];
  first: PixelSize | null;
  warnings: string[];
}

export interface MeasureOptions {
  imageServiceBaseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function normalizeFormat(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const format = value.trim().toLowerCase();
  if (format === "jpg" || format === "jpeg") return "jpeg";
  if (format === "png" || format === "webp") return format;
  return null;
}

function formatFromContentType(value: unknown): string | null {
  if (typeof value !== "string" || !value.includes("/")) return null;
  return normalizeFormat(value.slice(value.indexOf("/") + 1));
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function itemFor(image: NormalizedImage, index: number): ImageServiceItem {
  const uuid = String(index);
  if (image.url) return { uuid, url: image.url, params: { format: "json" } };
  if (image.b64_json) return { uuid, base64: image.b64_json, params: { format: "json" } };
  return { uuid, params: { format: "json" } };
}

/**
 * Measures the real pixel size and format of each generated image through
 * Edge-Images' `format=json` metadata. Failures are non-fatal: the value is
 * null and the caller degrades to the expected size.
 */
export async function measureOutputImages(
  images: NormalizedImage[],
  options: MeasureOptions,
): Promise<MeasuredOutputs> {
  const sizes: (PixelSize | null)[] = images.map(() => null);
  const formats: (string | null)[] = images.map(() => null);
  if (options.imageServiceBaseUrl === "") {
    return { sizes, formats, first: sizes[0] ?? null, warnings: [] };
  }

  const items = images.map(itemFor);
  const timeoutMs = options.timeoutMs ?? IMAGE_SERVICE_META_TIMEOUT_MS;
  let failed = false;

  for (let start = 0; start < items.length; start += IMAGE_SERVICE_MAX_ITEMS) {
    const chunk = items.slice(start, start + IMAGE_SERVICE_MAX_ITEMS);
    const batch = await postImageServiceBatch(chunk, {
      baseUrl: options.imageServiceBaseUrl,
      timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    if (!batch.ok) {
      failed = true;
      continue;
    }
    for (const item of chunk) {
      const index = Number(item.uuid);
      const entry = batch.results[item.uuid];
      if (typeof entry !== "object" || entry === null) {
        failed = true;
        continue;
      }
      const result = entry as { success?: unknown; data?: unknown };
      if (
        result.success !== true || typeof result.data !== "object" || result.data === null
      ) {
        failed = true;
        continue;
      }
      const data = result.data as Record<string, unknown>;
      const width = positiveInteger(data.width);
      const height = positiveInteger(data.height);
      if (width === null || height === null) {
        failed = true;
        continue;
      }
      sizes[index] = { width, height };
      formats[index] = normalizeFormat(data.format) ??
        formatFromContentType(data.sourceContentType);
    }
  }

  return {
    sizes,
    formats,
    first: sizes[0] ?? null,
    warnings: failed ? ["size-measure-failed"] : [],
  };
}
