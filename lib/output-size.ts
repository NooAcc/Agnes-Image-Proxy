import { decodeBase64 } from "@std/encoding/base64";
import { readImageDimensions } from "./image-dimensions.ts";
import { sniffImageMime } from "./image-mime.ts";
import type { NormalizedImage } from "./protocol.ts";
import { tryFetchImageHeader } from "./remote-image.ts";
import type { PixelSize } from "./size.ts";

export interface MeasuredOutputs {
  sizes: (PixelSize | null)[];
  mimes: (string | null)[];
  first: PixelSize | null;
  warnings: string[];
}

async function measureOne(
  image: NormalizedImage,
  fetchImpl?: typeof fetch,
): Promise<{ size: PixelSize | null; mime: string | null }> {
  if (image.b64_json) {
    try {
      const bytes = decodeBase64(image.b64_json);
      return { size: readImageDimensions(bytes), mime: sniffImageMime(bytes) };
    } catch {
      return { size: null, mime: null };
    }
  }
  if (image.url) {
    const fetched = await tryFetchImageHeader(image.url, { fetchImpl, allowHttp: false });
    return { size: fetched?.size ?? null, mime: fetched?.mime ?? null };
  }
  return { size: null, mime: null };
}

/**
 * Measures the real pixel size and MIME of each generated image. Failures are
 * non-fatal: the value is null and the caller degrades to the expected size.
 */
export async function measureOutputImages(
  images: NormalizedImage[],
  fetchImpl?: typeof fetch,
): Promise<MeasuredOutputs> {
  const measured = await Promise.all(images.map((image) => measureOne(image, fetchImpl)));
  const sizes = measured.map((item) => item.size);
  const warnings: string[] = [];
  if (images.length > 0 && sizes.some((size) => size === null)) {
    warnings.push("size-measure-failed");
  }
  return {
    sizes,
    mimes: measured.map((item) => item.mime),
    first: sizes[0] ?? null,
    warnings,
  };
}
