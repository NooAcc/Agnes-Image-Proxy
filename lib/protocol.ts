import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { ApiError } from "./errors.ts";
import { asObject } from "./http.ts";
import { readImageDimensions } from "./image-dimensions.ts";
import {
  isValidImageCount,
  MAX_INPUT_IMAGE_BYTES,
  MAX_INPUT_IMAGES,
  MAX_REQUEST_BYTES,
} from "./limits.ts";
import { sizeModeFor } from "./model-catalog.ts";
import { formatPixel, type ResolvedSize, resolveSize, type SizeTier } from "./size.ts";
import type { PixelSize } from "./size.ts";
import type { ResponseFormat } from "./settings.ts";

export type ImageEndpoint = "generations" | "edits";

export interface ProtocolDefaults {
  defaultSize: SizeTier;
  defaultRatio: string;
  defaultResponseFormat: ResponseFormat;
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

function isPixelSizeInput(value: string): boolean {
  return /^\d{1,6}\s*[x×]\s*\d{1,6}$/i.test(value);
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

function validateImageReference(value: string): string {
  if (value.startsWith("data:image/")) return value;
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
  if (!image || !image.startsWith("data:image/")) return null;
  const comma = image.indexOf(",");
  if (comma === -1 || !image.slice(0, comma).includes(";base64")) return null;
  try {
    return readImageDimensions(decodeBase64(image.slice(comma + 1)));
  } catch {
    return null;
  }
}

/** Collects reference images from the top-level image/images fields. */
function collectImages(obj: Record<string, unknown>): string[] {
  const images: string[] = [];
  if (obj.image !== undefined) images.push(...readImageValue(obj.image, "image"));
  if (obj.images !== undefined) images.push(...readImageValue(obj.images, "images"));
  return images.map(validateImageReference);
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

export function parseImageRequestJson(
  raw: unknown,
  endpoint: ImageEndpoint,
  defaults: ProtocolDefaults,
  reference?: PixelSize | null,
): ParsedImageRequest {
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
  const sizeInput = rawSize && rawSize !== "" ? rawSize : defaults.defaultSize;
  const isAuto = sizeInput.toLowerCase() === "auto";
  const isPixel = isPixelSizeInput(sizeInput);

  const extraBody: Record<string, unknown> = {};
  if (obj.extra_body !== undefined) {
    const extra = asObject(obj.extra_body);
    if (!extra) throw invalid("extra_body must be an object", "extra_body", "invalid_value");
    Object.assign(extraBody, extra);
  }

  const images = collectImages(obj);
  if (extraBody.image !== undefined) {
    images.push(
      ...readImageValue(extraBody.image, "image").map((value) => validateImageReference(value)),
    );
  }

  // Only the first reference image is inspected, and only locally readable bytes.
  const effectiveReference = isAuto ? (reference ?? referenceFromImage(images[0])) : null;

  let ratioInput = rawRatio;
  if (!ratioInput) {
    if (isPixel || (isAuto && effectiveReference)) ratioInput = undefined;
    else ratioInput = defaults.defaultRatio;
  }

  const size = resolveSize({ size: sizeInput, ratio: ratioInput, reference: effectiveReference });
  const responseFormat = readResponseFormat(obj, defaults);

  const warnings: string[] = [];
  for (const field of IGNORED_FIELDS) {
    if (obj[field] !== undefined) warnings.push(field);
  }
  for (const key of Object.keys(obj)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push(key);
  }
  if (isAuto && !effectiveReference && images.length > 0 && isHttpUrl(images[0])) {
    warnings.push("auto-size-from-url");
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

  if (sizeModeFor(request.model) === "exact") {
    body.size = formatPixel(request.size.pixel);
  } else {
    body.size = request.size.tier;
    body.ratio = request.size.ratio;
  }

  const extra: Record<string, unknown> = { ...request.extraBody };
  delete extra.image;
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

export function normalizeAgnesResponse(
  raw: unknown,
  request: ParsedImageRequest,
): NormalizedResponse {
  const obj = asObject(raw);
  if (!obj || !Array.isArray(obj.data)) {
    throw new ApiError(
      502,
      "upstream response is missing a data array",
      "server_error",
      null,
      "invalid_upstream_response",
    );
  }

  const images: NormalizedImage[] = obj.data.map((item) => {
    const entry = asObject(item) ?? {};
    return {
      url: optionalText(entry.url),
      b64_json: optionalText(entry.b64_json),
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
    output_format: "png",
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

/** Parses an OpenAI-style multipart image edit request. */
export async function parseImageRequestMultipart(
  request: Request,
  defaults: ProtocolDefaults,
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
    formData = await request.formData();
  } catch {
    throw invalid("request body is not valid multipart/form-data", "", "invalid_body");
  }

  const raw: Record<string, unknown> = {};
  const files: File[] = [];
  const urlImages: string[] = [];

  for (const [key, value] of formData.entries()) {
    if (key === "image" || key === "image[]" || key === "images") {
      if (typeof value === "string") urlImages.push(value);
      else files.push(value);
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

  if (files.length + urlImages.length === 0) {
    throw invalid("at least one image is required", "image", "missing_parameter");
  }
  if (files.length + urlImages.length > MAX_INPUT_IMAGES) {
    throw invalid(
      `at most ${MAX_INPUT_IMAGES} images are allowed`,
      "image",
      "too_many_images",
    );
  }

  const dataUris: string[] = [];
  let totalBytes = 0;
  let firstBytes: Uint8Array | null = null;
  for (const file of files) {
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
    if (firstBytes === null) firstBytes = bytes;
    dataUris.push(`data:${file.type};base64,${encodeBase64(bytes)}`);
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

  const autoSize = typeof raw.size === "string" && raw.size.toLowerCase() === "auto";
  const reference = autoSize
    ? (firstBytes ? readImageDimensions(firstBytes) : referenceFromImage(urlImages[0]))
    : null;

  const images = [...dataUris, ...urlImages].map(validateImageReference);
  raw.image = images;

  return parseImageRequestJson(raw, "edits", defaults, reference);
}
