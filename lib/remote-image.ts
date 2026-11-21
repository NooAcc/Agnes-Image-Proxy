import { ApiError } from "./errors.ts";
import { readImageDimensions } from "./image-dimensions.ts";
import { sniffImageMime } from "./image-mime.ts";
import {
  REMOTE_IMAGE_MAX_BYTES,
  REMOTE_IMAGE_MAX_REDIRECTS,
  REMOTE_IMAGE_TIMEOUT_MS,
} from "./limits.ts";
import type { PixelSize } from "./size.ts";

export interface FetchImageOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowHttp?: boolean;
}

export interface FetchedImage {
  size: PixelSize;
  mime: string | null;
}

function referenceError(message: string, code: string): ApiError {
  return new ApiError(400, message, "invalid_request_error", "image", code);
}

function unavailable(): ApiError {
  return referenceError("reference image is unavailable", "reference_image_unavailable");
}

function isAllowedUrl(value: string, allowHttp: boolean): boolean {
  return allowHttp ? isPublicHttpUrl(value) : isPublicHttpsUrl(value);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readHeader(
  response: Response,
  maxBytes: number,
): Promise<FetchedImage> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw referenceError("reference image is too large", "reference_image_too_large");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw referenceError("reference image is too large", "reference_image_too_large");
    }
    const dimensions = readImageDimensions(buffer);
    if (!dimensions) {
      throw referenceError("reference image format is unsupported", "reference_image_unsupported");
    }
    return { size: dimensions, mime: sniffImageMime(buffer) };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw referenceError("reference image is too large", "reference_image_too_large");
    }
    chunks.push(value);
    const bytes = concat(chunks, total);
    const dimensions = readImageDimensions(bytes);
    if (dimensions) {
      await reader.cancel();
      return { size: dimensions, mime: sniffImageMime(bytes) };
    }
  }

  throw referenceError("reference image format is unsupported", "reference_image_unsupported");
}

/**
 * Fetches only the image header from a public URL and returns its pixel size
 * and sniffed MIME. Credentials, private hosts, non-image bodies and bodies
 * over the byte limit are rejected before or during the read.
 */
export async function fetchImageHeader(
  url: string,
  options: FetchImageOptions = {},
): Promise<FetchedImage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? REMOTE_IMAGE_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? REMOTE_IMAGE_MAX_REDIRECTS;
  const allowHttp = options.allowHttp ?? true;

  let current = url;
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (!isAllowedUrl(current, allowHttp)) throw unavailable();

    let response: Response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw unavailable();
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw unavailable();
      try {
        current = new URL(location, current).toString();
      } catch {
        throw unavailable();
      }
      continue;
    }

    if (!response.ok) throw unavailable();

    try {
      return await readHeader(response, maxBytes);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  }

  throw unavailable();
}

/** Like fetchImageHeader, but only the pixel size. */
export async function fetchImageDimensions(
  url: string,
  options: FetchImageOptions = {},
): Promise<PixelSize> {
  return (await fetchImageHeader(url, options)).size;
}

/** Like fetchImageHeader, but never throws; failures become null. */
export async function tryFetchImageHeader(
  url: string,
  options: FetchImageOptions = {},
): Promise<FetchedImage | null> {
  try {
    return await fetchImageHeader(url, options);
  } catch {
    return null;
  }
}

/** Like fetchImageDimensions, but never throws; failures become null. */
export async function tryFetchImageDimensions(
  url: string,
  options: FetchImageOptions = {},
): Promise<PixelSize | null> {
  return (await tryFetchImageHeader(url, options))?.size ?? null;
}

function isPublicIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const values = parts.map(Number);
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = values;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

function isPublicHost(hostname: string): boolean {
  // A trailing dot (or several) is a canonical alias for the same DNS name.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return false;

  if (host.includes(":")) {
    if (host === "::" || host === "::1") return false;
    if (host.startsWith("::ffff:")) return isPublicIPv4(host.slice("::ffff:".length));
    const first = host.split(":")[0];
    if (/^f[cd][0-9a-f]{0,2}$/.test(first)) return false; // fc00::/7
    if (/^fe[89ab][0-9a-f]{0,2}$/.test(first)) return false; // fe80::/10
    return true;
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPublicIPv4(host);
  return true;
}

/** Only https URLs without credentials on public hosts are acceptable. */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return isPublicHost(url.hostname);
}

/** http(s) URLs without credentials on public hosts are acceptable. */
export function isPublicHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return isPublicHost(url.hostname);
}
