import { decodeBase64 } from "@std/encoding/base64";
import { readImageDimensions } from "./image-dimensions.ts";
import type { NormalizedImage } from "./protocol.ts";
import { tryFetchImageDimensions } from "./remote-image.ts";
import type { PixelSize } from "./size.ts";

export interface MeasuredOutputs {
  sizes: (PixelSize | null)[];
  first: PixelSize | null;
  warnings: string[];
}

async function measureOne(
  image: NormalizedImage,
  fetchImpl?: typeof fetch,
): Promise<PixelSize | null> {
  if (image.b64_json) {
    try {
      return readImageDimensions(decodeBase64(image.b64_json));
    } catch {
      return null;
    }
  }
  if (image.url) {
    return await tryFetchImageDimensions(image.url, { fetchImpl, allowHttp: false });
  }
  return null;
}

/**
 * Measures the real pixel size of each generated image. Failures are
 * non-fatal: the size is null and the caller degrades to the expected size.
 */
export async function measureOutputImages(
  images: NormalizedImage[],
  fetchImpl?: typeof fetch,
): Promise<MeasuredOutputs> {
  const sizes = await Promise.all(images.map((image) => measureOne(image, fetchImpl)));
  const warnings: string[] = [];
  if (images.length > 0 && sizes.some((size) => size === null)) {
    warnings.push("size-measure-failed");
  }
  return { sizes, first: sizes[0] ?? null, warnings };
}
