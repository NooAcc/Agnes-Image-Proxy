import { ApiError } from "./errors.ts";
import { asObject } from "./http.ts";
import { UPSTREAM_TIMEOUT_MS } from "./limits.ts";
import type { AgnesClient, AgnesRequest, AgnesResult } from "./pool.ts";

export type { AgnesClient, AgnesRequest, AgnesResult } from "./pool.ts";

export interface AgnesClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

function errorType(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "server_error";
}

function mapUpstreamStatus(status: number): number {
  if (status >= 500) return 502;
  return status;
}

function isAbort(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }
  return typeof error === "object" && error !== null &&
    (error as { name?: string }).name === "AbortError";
}

/** Extracts a human-readable message from an upstream error payload. */
export function upstreamMessage(body: unknown, status: number): string {
  const error = asObject(asObject(body)?.error);
  const message = error?.message;
  if (typeof message === "string" && message.trim() !== "") return message.trim();
  if (typeof body === "string" && body.trim() !== "") return body.trim().slice(0, 500);
  return `upstream request failed with status ${status}`;
}

export function createAgnesClient(options: AgnesClientOptions): AgnesClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;

  return {
    async generate(request: AgnesRequest, signal?: AbortSignal): Promise<AgnesResult> {
      const url = joinUrl(options.baseUrl, request.path);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request.body),
          signal: combined,
        });
      } catch (error) {
        if (isAbort(error) || timeoutSignal.aborted) {
          throw new ApiError(
            504,
            "upstream request timed out",
            "server_error",
            null,
            "upstream_timeout",
          );
        }
        throw new ApiError(
          502,
          `upstream request failed: ${error instanceof Error ? error.message : String(error)}`,
          "server_error",
          null,
          "upstream_unreachable",
        );
      }

      const text = await response.text();
      let body: unknown = text;
      if (text.trim() !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }

      if (response.ok) return { status: response.status, body };

      const status = mapUpstreamStatus(response.status);
      const headers = new Headers();
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter !== null) headers.set("retry-after", retryAfter);
      throw new ApiError(
        status,
        upstreamMessage(body, response.status),
        errorType(response.status),
        null,
        null,
        headers,
      );
    },
  };
}
