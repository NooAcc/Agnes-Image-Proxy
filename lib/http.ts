import { ApiError, errorResponseBody } from "./errors.ts";
import { MAX_REQUEST_BYTES } from "./limits.ts";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const CONSOLE_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function mergeHeaders(init: HeadersInit | undefined, defaults: Record<string, string>): Headers {
  const headers = new Headers(init);
  for (const [key, value] of Object.entries(defaults)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return headers;
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = mergeHeaders(init.headers, { "content-type": JSON_CONTENT_TYPE });
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** Reads and size-limits a JSON request body. */
export async function readJsonBody(request: Request): Promise<unknown> {
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

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new ApiError(
      413,
      "request body is too large",
      "invalid_request_error",
      null,
      "request_too_large",
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "request body is not valid JSON", "invalid_request_error");
  }
}

/** Reads and size-limits a multipart request body while streaming it. */
export async function readLimitedFormData(
  request: Request,
  maxBytes: number,
): Promise<FormData> {
  const contentType = request.headers.get("content-type");
  if (!request.body) {
    if (!contentType) {
      throw new ApiError(400, "request body is empty", "invalid_request_error");
    }
    return await request.formData();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiError(
        413,
        "request body is too large",
        "invalid_request_error",
        null,
        "request_too_large",
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (!contentType) {
    throw new ApiError(
      400,
      "request body is not valid multipart/form-data",
      "invalid_request_error",
    );
  }
  return await new Response(bytes, { headers: { "content-type": contentType } }).formData();
}

export function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function methodNotAllowed(allowed: string[]): Response {
  const response = errorResponse(
    new ApiError(405, "method not allowed", "invalid_request_error"),
  );
  response.headers.set("allow", allowed.join(", "));
  return response;
}

/** Maps any thrown value onto an OpenAI-style error response. */
export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonResponse(errorResponseBody(error), {
      status: error.status,
      headers: error.headers,
    });
  }
  console.error("unhandled error:", error);
  return jsonResponse(errorResponseBody(new ApiError(500, "internal server error")), {
    status: 500,
  });
}

export function htmlResponse(html: string, init: ResponseInit = {}): Response {
  const headers = mergeHeaders(init.headers, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": CONSOLE_CSP,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
  return new Response(html, { ...init, headers });
}

export function bytesResponse(bytes: Uint8Array, mime: string, init: ResponseInit = {}): Response {
  const headers = mergeHeaders(init.headers, {
    "content-type": mime,
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; sandbox",
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
  });
  const body = bytes.slice().buffer as ArrayBuffer;
  return new Response(body, { ...init, headers });
}

/** Marks a response as uncacheable without overriding a more specific policy. */
export function noStore(response: Response): Response {
  if (!response.headers.has("cache-control")) {
    response.headers.set("cache-control", "no-store");
  }
  return response;
}

/** Appends warning tags to the X-Agnes-Warnings header without duplicates. */
export function addWarnings(headers: Headers, warnings: Iterable<string>): void {
  const existing = (headers.get("x-agnes-warnings") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  for (const warning of warnings) {
    if (!existing.includes(warning)) existing.push(warning);
  }
  if (existing.length > 0) headers.set("x-agnes-warnings", existing.join(","));
}

export function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
