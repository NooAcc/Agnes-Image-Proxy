import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { ApiError } from "./errors.ts";
import { asObject, readLimitedFormData } from "./http.ts";
import { readImageDimensions } from "./image-dimensions.ts";
import {
  isValidImageCount,
  MAX_INPUT_IMAGE_BYTES,
  MAX_INPUT_IMAGES,
  MAX_REQUEST_BYTES,
} from "./limits.ts";
import { formatPixel, type ResolvedSize, resolveSize, type SizeTier } from "./size.ts";
import type { PixelSize } from "./size.ts";
import { fetchImageDimensions } from "./remote-image.ts";
import type { ResponseFormat } from "./settings.ts";

export type ImageEndpoint = "generations" | "edits";

export interface ProtocolDefaults {
  defaultSize: SizeTier;
  defaultResponseFormat: ResponseFormat;
}

export interface ParseImageOptions {
  fetchImpl?: typeof fetch;
}

export interface ParsedImageRequest {
  endpoint: ImageEndpoint;
  model: string;
  prompt: string;
  n: number;
  size: ResolvedSize;
  responseFormat: ResponseFormat;
  images: string[];
  warnings: string[];
  extraBody: Record<string, unknown>;
}

export interface NormalizedImage {
  url: string | null;
  b64_json: string | null;
  revised_prompt: string | null;
}

export interface NormalizedResponse {
  body: Record<string, unknown>;
  images: NormalizedImage[];
  warnings: string[];
}

const IGNORED_FIELDS = [
  "quality",
  "background",
  "output_format",
  "output_compression",
  "moderation",
  "style",
  "input_fidelity",
  "user",
  "safety_identifier",
];

const KNOWN_FIELDS = new Set([
  ...IGNORED_FIELDS,
  "model",
  "prompt",
  "n",
  "size",
  "ratio",
  "response_format",
  "return_base64",
  "extra_body",
  "stream",
  "partial_images",
  "image",
  "images",
]);

function invalid(message: string, param: string, code: string | null = null): ApiError {
  return new ApiError(400, message, "invalid_request_error", param, code);
}

function readImageValue(value: unknown, param: string): string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (!Array.isArray(value)) {
    throw invalid(
      `${param} must be a string, an array of strings or an array of {image_url}`,
      param,
      "unsupported_parameter",
    );
  }
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    const entry = asObject(item);
    if (entry) {
      if (entry.file_id !== undefined) {
        throw invalid("file_id is not supported", param, "unsupported_parameter");
      }
      if (typeof entry.image_url === "string" && entry.image_url !== "") {
        return [entry.image_url];
      }
    }
    throw invalid(
      `${param} entries must be strings or {image_url}`,
      param,
      "unsupported_parameter",
    );
  });
}

const DATA_URI_PREFIX = /^data:image\/(png|jpeg|jpg|webp);base64,/i;

export interface ParsedDataUri {
  mime: "image/png" | "image/jpeg" | "image/webp";
  byteLength: number;
}

/** Parses a base64 image data URI without decoding it. */
export function parseDataUri(value: string): ParsedDataUri | null {
  const match = DATA_URI_PREFIX.exec(value);
  if (!match) return null;
  const payload = value.slice(match[0].length);
  if (payload === "" || payload.length % 4 !== 0) return null;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  if (payload.slice(0, payload.length - padding).includes("=")) return null;
  const subtype = match[1].toLowerCase();
  return {
    mime: subtype === "jpg" ? "image/jpeg" : `image/${subtype}` as ParsedDataUri["mime"],
    byteLength: (payload.length / 4) * 3 - padding,
  };
}

function validateImageReference(value: string): string {
  if (/^data:/i.test(value)) {
    const parsed = parseDataUri(value);
    if (!parsed) {
      throw invalid(
        "reference data URI is unsupported; use png, jpeg or webp with base64 encoding",
        "image",
        "unsupported_parameter",
      );
    }
    return `data:${parsed.mime};base64,${value.slice(value.indexOf(",") + 1)}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("reference images must be http(s) URLs or data URIs", "image");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid("reference images must be http(s) URLs or data URIs", "image");
  }
  return value;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

/** Reads dimensions from a base64 data URI without any network access. */
function referenceFromImage(image: string | undefined): PixelSize | null {
  if (!image) return null;
  const parsed = parseDataUri(image);
  if (!parsed) return null;
  try {
    return readImageDimensions(decodeBase64(image.slice(image.indexOf(",") + 1)));
  } catch {
    return null;
  }
}

function unreadableReference(): ApiError {
  return new ApiError(
    400,
    "reference image dimensions could not be read",
    "invalid_request_error",
    "image",
    "reference_image_unsupported",
  );
}

/** Resolves the real pixel size of the first reference image for auto sizing. */
async function referenceSizeForAuto(
  image: string | undefined,
  provided: PixelSize | null | undefined,
  fetchImpl?: typeof fetch,
): Promise<PixelSize> {
  if (provided) return provided;
  if (!image) throw unreadableReference();
  if (image.startsWith("data:image/")) {
    const dimensions = referenceFromImage(image);
    if (dimensions) return dimensions;
    throw unreadableReference();
  }
  if (isHttpUrl(image)) {
    return await fetchImageDimensions(image, { fetchImpl, allowHttp: true });
  }
  throw unreadableReference();
}

/** Collects reference images from the top-level fields and extra_body.image. */
function collectImages(
  obj: Record<string, unknown>,
  extraBody: Record<string, unknown>,
): string[] {
  const raw: string[] = [];
  if (obj.image !== undefined) raw.push(...readImageValue(obj.image, "image"));
  if (obj.images !== undefined) raw.push(...readImageValue(obj.images, "images"));
  if (extraBody.image !== undefined) raw.push(...readImageValue(extraBody.image, "image"));

  if (raw.length > MAX_INPUT_IMAGES) {
    throw invalid(
      `at most ${MAX_INPUT_IMAGES} images are allowed`,
      "image",
      "too_many_images",
    );
  }

  return raw.map((value) => {
    const normalized = validateImageReference(value);
    const data = parseDataUri(normalized);
    if (data !== null && data.byteLength > MAX_INPUT_IMAGE_BYTES) {
      throw invalid("input image is too large", "image", "image_too_large");
    }
    return normalized;
  });
}

function readResponseFormat(
  obj: Record<string, unknown>,
  defaults: ProtocolDefaults,
): ResponseFormat {
  let format = defaults.defaultResponseFormat;
  if (obj.response_format !== undefined) {
    if (obj.response_format !== "url" && obj.response_format !== "b64_json") {
      throw invalid(
        "response_format must be url or b64_json",
        "response_format",
        "invalid_value",
      );
    }
    format = obj.response_format;
  }
  if (obj.return_base64 !== undefined) {
    if (typeof obj.return_base64 !== "boolean") {
      throw invalid("return_base64 must be a boolean", "return_base64", "invalid_value");
    }
    format = obj.return_base64 ? "b64_json" : "url";
  }
  return format;
}

export async function parseImageRequestJson(
  raw: unknown,
  endpoint: ImageEndpoint,
  defaults: ProtocolDefaults,
  reference?: PixelSize | null,
  options?: ParseImageOptions,
): Promise<ParsedImageRequest> {
  const obj = asObject(raw);
  if (!obj) throw invalid("request body must be a JSON object", "", "invalid_body");

  if (obj.stream === true) {
    throw invalid("stream is not supported", "stream", "unsupported_parameter");
  }
  if (obj.partial_images !== undefined) {
    throw invalid("partial_images is not supported", "partial_images", "unsupported_parameter");
  }
  if (obj.mask !== undefined) {
    throw invalid("mask is not supported", "mask", "unsupported_parameter");
  }
  if (obj.file_id !== undefined) {
    throw invalid("file_id is not supported", "file_id", "unsupported_parameter");
  }

  const model = typeof obj.model === "string" ? obj.model.trim() : "";
  if (model === "") throw invalid("model is required", "model", "missing_parameter");
  const prompt = typeof obj.prompt === "string" ? obj.prompt : "";
  if (prompt.trim() === "") throw invalid("prompt is required", "prompt", "missing_parameter");

  let n = 1;
  if (obj.n !== undefined) {
    if (!isValidImageCount(obj.n)) {
      throw invalid("n must be a positive integer", "n", "invalid_value");
    }
    n = obj.n;
  }

  if (obj.size !== undefined && typeof obj.size !== "string") {
    throw invalid("size must be a string", "size", "invalid_value");
  }
  if (obj.ratio !== undefined && typeof obj.ratio !== "string") {
    throw invalid("ratio must be a string", "ratio", "invalid_value");
  }

  const rawSize = typeof obj.size === "string" ? obj.size.trim() : undefined;
  const rawRatio = typeof obj.ratio === "string" ? obj.ratio.trim() : undefined;
  const autoTrigger = rawSize === undefined || rawSize === "" || rawSize.toLowerCase() === "auto";

  const extraBody: Record<string, unknown> = {};
  if (obj.extra_body !== undefined) {
    const extra = asObject(obj.extra_body);
    if (!extra) throw invalid("extra_body must be an object", "extra_body", "invalid_value");
    Object.assign(extraBody, extra);
  }

  const images = collectImages(obj, extraBody);

  let size: ResolvedSize;
  if (autoTrigger && images.length > 0) {
    const referenceSize = await referenceSizeForAuto(images[0], reference, options?.fetchImpl);
    size = resolveSize({ size: "auto", ratio: rawRatio, reference: referenceSize });
  } else if (autoTrigger) {
    size = resolveSize({ size: defaults.defaultSize, ratio: rawRatio });
  } else {
    size = resolveSize({ size: rawSize, ratio: rawRatio });
  }
  const responseFormat = readResponseFormat(obj, defaults);

  const warnings: string[] = [];
  for (const field of IGNORED_FIELDS) {
    if (obj[field] !== undefined) warnings.push(field);
  }
  for (const key of Object.keys(obj)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push(key);
  }

  return {
    endpoint,
    model,
    prompt,
    n,
    size,
    responseFormat,
    images,
    warnings: [...new Set(warnings)],
    extraBody,
  };
}

export function agnesPayload(
  request: ParsedImageRequest,
  mode: "nested" | "top_level",
): { path: string; body: Record<string, unknown> } {
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
  };

  if (request.size.mode === "exact" && request.size.requestedPixel) {
    body.size = formatPixel(request.size.requestedPixel);
  } else {
    body.size = request.size.tier;
  }
  if (request.size.ratio !== null) body.ratio = request.size.ratio;

  const extra: Record<string, unknown> = { ...request.extraBody };
  delete extra.image;
  delete extra.ratio;
  delete extra.response_format;
  delete extra.return_base64;
  delete extra.n;

  if (request.images.length > 0) {
    if (mode === "top_level") body.image = request.images;
    else extra.image = request.images;
    extra.response_format = request.responseFormat;
  } else if (request.responseFormat === "b64_json") {
    body.return_base64 = true;
  } else {
    extra.response_format = "url";
  }

  if (Object.keys(extra).length > 0) body.extra_body = extra;
  return { path: "/images/generations", body };
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function missingImages(): ApiError {
  return new ApiError(
    502,
    "upstream response is missing images",
    "server_error",
    null,
    "invalid_upstream_response",
  );
}

export function normalizeAgnesResponse(
  raw: unknown,
  request: ParsedImageRequest,
): NormalizedResponse {
  const obj = asObject(raw);
  if (!obj || !Array.isArray(obj.data) || obj.data.length === 0) {
    throw missingImages();
  }

  const images: NormalizedImage[] = obj.data.map((item) => {
    const entry = asObject(item);
    const url = optionalText(entry?.url);
    const b64Json = optionalText(entry?.b64_json);
    if (!entry || (url === null && b64Json === null)) throw missingImages();
    return {
      url,
      b64_json: b64Json,
      revised_prompt: null,
    };
  });

  const warnings: string[] = [];
  if (
    request.responseFormat === "b64_json" && images.length > 0 &&
    images.every((image) => image.b64_json === null)
  ) {
    warnings.push("upstream-returned-url");
  }

  const created = typeof obj.created === "number" ? obj.created : Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = {
    created,
    data: images,
    size: formatPixel(request.size.pixel),
  };

  return { body, images, warnings };
}

export function mergeNormalizedResponses(responses: NormalizedResponse[]): NormalizedResponse {
  const images: NormalizedImage[] = responses.flatMap((response) => response.images);
  const warnings = [...new Set(responses.flatMap((response) => response.warnings))];
  const first = responses[0]?.body ?? {};
  const body: Record<string, unknown> = {
    ...first,
    created: first.created ?? Math.floor(Date.now() / 1000),
    data: images,
  };
  return { body, images, warnings };
}

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type ImageInput =
  | { kind: "file"; file: File }
  | { kind: "url"; url: string };

/** Parses an OpenAI-style multipart image edit request. */
export async function parseImageRequestMultipart(
  request: Request,
  defaults: ProtocolDefaults,
  options: ParseImageOptions = {},
): Promise<ParsedImageRequest> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new ApiError(
      413,
      "request body is too large",
      "invalid_request_error",
      null,
      "request_too_large",
    );
  }

  let formData: FormData;
  try {
    formData = await readLimitedFormData(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalid("request body is not valid multipart/form-data", "", "invalid_body");
  }

  const raw: Record<string, unknown> = {};
  const inputs: ImageInput[] = [];

  for (const [key, value] of formData.entries()) {
    if (key === "image" || key === "image[]" || key === "images") {
      if (typeof value === "string") inputs.push({ kind: "url", url: value });
      else inputs.push({ kind: "file", file: value });
      continue;
    }
    if (key === "mask") {
      throw invalid("mask is not supported", "mask", "unsupported_parameter");
    }
    if (key === "file_id") {
      throw invalid("file_id is not supported", "file_id", "unsupported_parameter");
    }
    if (typeof value !== "string") continue;
    switch (key) {
      case "n":
        raw.n = value === "" ? undefined : Number(value);
        break;
      case "return_base64":
        raw.return_base64 = value === "true" || value === "1";
        break;
      case "stream":
        raw.stream = value === "true" || value === "1";
        break;
      case "extra_body":
        try {
          raw.extra_body = JSON.parse(value);
        } catch {
          throw invalid("extra_body must be valid JSON", "extra_body", "invalid_value");
        }
        break;
      default:
        raw[key] = value;
    }
  }

  if (inputs.length === 0) {
    throw invalid("at least one image is required", "image", "missing_parameter");
  }
  if (inputs.length > MAX_INPUT_IMAGES) {
    throw invalid(
      `at most ${MAX_INPUT_IMAGES} images are allowed`,
      "image",
      "too_many_images",
    );
  }

  const images: string[] = [];
  let firstBytes: Uint8Array | null = null;
  let totalBytes = 0;
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index];
    if (input.kind === "url") {
      images.push(validateImageReference(input.url));
      continue;
    }
    const file = input.file;
    if (!IMAGE_MIME_TYPES.has(file.type)) {
      throw invalid(
        `unsupported image type: ${file.type || "unknown"} (expected png, jpeg or webp)`,
        "image",
        "unsupported_parameter",
      );
    }
    if (file.size > MAX_INPUT_IMAGE_BYTES) {
      throw invalid("input image is too large", "image", "image_too_large");
    }
    totalBytes += file.size;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (index === 0) firstBytes = bytes;
    images.push(`data:${file.type};base64,${encodeBase64(bytes)}`);
  }
  if (totalBytes > MAX_REQUEST_BYTES) {
    throw new ApiError(
      413,
      "request body is too large",
      "invalid_request_error",
      null,
      "request_too_large",
    );
  }

  const rawSizeValue = typeof raw.size === "string" ? raw.size.trim() : "";
  const autoTrigger = rawSizeValue === "" || rawSizeValue.toLowerCase() === "auto";
  const reference = autoTrigger
    ? (firstBytes ? readImageDimensions(firstBytes) : referenceFromImage(images[0]))
    : null;

  raw.image = images;

  return parseImageRequestJson(raw, "edits", defaults, reference, options);
}
