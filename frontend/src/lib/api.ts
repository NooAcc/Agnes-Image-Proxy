import type { z } from "zod";

export class ApiError extends Error {
  readonly status: number;
  readonly param: string | null;
  readonly code: string | null;

  constructor(status: number, message: string, param: string | null = null, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.param = param;
    this.code = code;
  }
}

interface ErrorEnvelope {
  error?: {
    message?: string;
    param?: string | null;
    code?: string | null;
  };
}

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;
let sessionGeneration = 0;
export function currentSessionGeneration(): number { return sessionGeneration; }
export function advanceSessionGeneration(): void { sessionGeneration += 1; }

// setUnauthorizedHandler registers the single central reaction to an expired
// session. Providers use it to clear cached admin data; navigation is driven by
// the session query guard so requests cannot redirect in a loop.
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export function notifyUnauthorized(generation = sessionGeneration): void {
  if (generation === sessionGeneration) unauthorizedHandler?.();
}

// A rejected login does not expire an existing authenticated session.
function isLogin(path: string, method: string): boolean {
  return path === "/admin/api/session" && method === "POST";
}

// api performs a same-origin request using cookie credentials and surfaces the
// OpenAI error envelope as ApiError.
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const generation = currentSessionGeneration();
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
  });

  if (!response.ok) {
    let message = response.statusText || "请求失败";
    let param: string | null = null;
    let code: string | null = null;
    try {
      const body = (await response.json()) as ErrorEnvelope;
      if (body.error?.message) {
        message = body.error.message;
      }
      param = body.error?.param ?? null;
      code = body.error?.code ?? null;
    } catch {
      // Non-JSON errors keep the status text.
    }
    const method = (options.method ?? "GET").toUpperCase();
    if (response.status === 401 && !isLogin(path, method)) {
      notifyUnauthorized(generation);
    }
    throw new ApiError(response.status, message, param, code);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

// apiValidated parses a response through its runtime schema so contract drift
// fails loudly instead of rendering undefined fields.
export async function apiValidated<T>(
  schema: z.ZodType<T>,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const data = await api<unknown>(path, options);
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error("服务器返回了无法识别的数据格式");
  }
  return parsed.data;
}
