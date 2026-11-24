import { vi } from "vitest";

export interface MockRequest {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
  headers: Headers;
}

export type MockHandler = (
  request: MockRequest,
) => Response | undefined | Promise<Response | undefined>;

export interface MockServer {
  calls: MockRequest[];
  stop: () => void;
}

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(data === undefined ? null : JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(
  status: number,
  message: string,
  param: string | null = null,
  code: string | null = null,
) {
  return jsonResponse({ error: { message, type: "invalid_request_error", param, code } }, status);
}

// startServer installs a fetch-level mock that dispatches to handlers in order.
// It is a dependency-free stand-in for MSW; handlers mirror the same shape.
export function startServer(handlers: MockHandler[]): MockServer {
  const original = globalThis.fetch;
  const calls: MockRequest[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "http://localhost");
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const request: MockRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      search: url.searchParams,
      body,
      headers: new Headers(init?.headers),
    };
    calls.push(request);
    for (const handler of handlers) {
      const response = await handler(request);
      if (response) {
        return response;
      }
    }
    return errorResponse(404, "not found", null, "unknown_path");
  });
  vi.stubGlobal("fetch", mock);
  return {
    calls,
    stop: () => {
      globalThis.fetch = original;
    },
  };
}
