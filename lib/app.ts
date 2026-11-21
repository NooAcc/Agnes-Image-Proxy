import type { AccountStore, ClaimedAccount } from "./accounts.ts";
import type { Archiver } from "./archive.ts";
import { readCookie, type SessionService, timingSafeEqual } from "./auth.ts";
import { ApiError } from "./errors.ts";
import {
  addWarnings,
  errorResponse,
  htmlResponse,
  jsonResponse,
  methodNotAllowed,
  normalizePath,
  readJsonBody,
} from "./http.ts";
import type { AttemptTrace, RequestLogInput, RequestLogStore, SubRequestTrace } from "./logs.ts";
import { imageModelList } from "./model-catalog.ts";
import type { ModelUsageStore } from "./model-usage.ts";
import type { AccountPool, GatewayHooks, GatewayOptions } from "./pool.ts";
import { selectFailure } from "./pool.ts";
import {
  agnesPayload,
  type ImageEndpoint,
  mergeNormalizedResponses,
  normalizeAgnesResponse,
  type NormalizedResponse,
  type ParsedImageRequest,
  parseImageRequestJson,
  parseImageRequestMultipart,
  type ProtocolDefaults,
} from "./protocol.ts";
import type { AppSettings, SettingsStore } from "./settings.ts";
import { formatPixel, formatRequestSize, type PixelSize } from "./size.ts";
import { measureOutputImages } from "./output-size.ts";

export const SESSION_COOKIE = "agnes_session";

export interface AdminRouter {
  matches(path: string): boolean;
  handle(request: Request, path: string): Promise<Response>;
}

export interface HandlerOptions {
  pool: AccountPool;
  store: AccountStore;
  settings: SettingsStore;
  admin: AdminRouter;
  logs: RequestLogStore;
  modelUsage: ModelUsageStore;
  archiver: Archiver;
  apiKey: string;
  session: SessionService;
  renderAdminPage?: () => string;
  renderLoginPage?: () => string;
  corsAllowedOrigins?: string[];
  readyCheck?: () => Promise<void>;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

interface SubRequestSuccess {
  status: number;
  account: { id: number; name: string };
  normalized: NormalizedResponse;
  actualSizes: (PixelSize | null)[];
}

type SubRequestOutcome =
  | { ok: true; result: SubRequestSuccess; traces: AttemptTrace[] }
  | { ok: false; error: unknown; traces: AttemptTrace[] };

const MAX_TRACE_MESSAGE = 200;

function truncateMessage(message: string): string {
  return message.length > MAX_TRACE_MESSAGE ? message.slice(0, MAX_TRACE_MESSAGE) : message;
}

function attemptTrace(
  account: ClaimedAccount,
  error: unknown,
  durationMs: number,
): AttemptTrace {
  if (error === null) {
    return {
      accountId: account.id,
      accountName: account.name,
      status: 200,
      code: null,
      durationMs,
      message: null,
    };
  }
  const apiError = error instanceof ApiError ? error : null;
  return {
    accountId: account.id,
    accountName: account.name,
    status: apiError?.status ?? 502,
    code: apiError?.code ?? null,
    durationMs,
    message: truncateMessage(errorMessage(error)),
  };
}

const JSON_TYPE = "application/json; charset=utf-8";

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function parseJsonOrDefaults(settings: AppSettings): ProtocolDefaults {
  return {
    defaultSize: settings.defaultSize,
    defaultResponseFormat: settings.defaultResponseFormat,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): number {
  return error instanceof ApiError ? error.status : 500;
}

export function createHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? (() => new Date());
  const corsAllowed = options.corsAllowedOrigins ?? [];
  const renderAdminPage = options.renderAdminPage ?? (() => "<h1>Agnes console</h1>");
  const renderLoginPage = options.renderLoginPage ?? (() => "<h1>Login</h1>");

  const authorized = (request: Request): boolean => {
    const token = bearerToken(request);
    return token !== null && timingSafeEqual(token, options.apiKey);
  };

  const hasAdminAccess = async (request: Request): Promise<boolean> => {
    if (authorized(request)) return true;
    const token = readCookie(request, SESSION_COOKIE);
    if (!token) return false;
    return (await options.session.verify(token, now())) !== null;
  };

  const applyCors = (request: Request, response: Response): Response => {
    const origin = request.headers.get("origin");
    if (!origin || !corsAllowed.includes(origin)) return response;
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
    return new Response(response.body, { status: response.status, headers });
  };

  async function writeLog(
    input: Omit<
      RequestLogInput,
      "ts" | "endpoint" | "path" | "model" | "accountId" | "accountName" | "durationMs"
    >,
    parsed: ParsedImageRequest,
    path: string,
    startedAt: number,
    account: { id: number; name: string } | null,
  ): Promise<void> {
    const ts = now().toISOString();
    try {
      await options.logs.record({
        ts,
        endpoint: parsed.endpoint,
        path,
        model: parsed.model,
        accountId: account?.id ?? null,
        accountName: account?.name ?? null,
        durationMs: Date.now() - startedAt,
        ...input,
      });
      await options.modelUsage.record({
        model: parsed.model,
        day: ts.slice(0, 10),
        images: input.images,
        requested: input.requested,
        failed: input.failed,
        at: ts,
      });
    } catch (error) {
      console.error("request bookkeeping failed:", error);
    }
  }

  async function writeParseFailure(
    requestId: string,
    endpoint: ImageEndpoint,
    path: string,
    startedAt: number,
    error: unknown,
  ): Promise<void> {
    const apiError = error instanceof ApiError ? error : null;
    try {
      await options.logs.record({
        requestId,
        ts: now().toISOString(),
        stage: "parse",
        endpoint,
        path,
        model: null,
        accountId: null,
        accountName: null,
        status: apiError?.status ?? 500,
        ok: false,
        durationMs: Date.now() - startedAt,
        requested: null,
        images: 0,
        failed: 0,
        sizeRequest: null,
        sizeActual: null,
        errorCode: apiError?.code ?? "invalid_request",
        error: apiError?.message ?? errorMessage(error),
        attempts: [],
      });
    } catch (bookkeepingError) {
      console.error("request bookkeeping failed:", bookkeepingError);
    }
  }

  async function handleImageRequest(
    parsed: ParsedImageRequest,
    settings: AppSettings,
    path: string,
    startedAt: number,
    requestId: string,
  ): Promise<Response> {
    const preferredMode = settings.imageParamMode;

    const gatewayOptions: GatewayOptions = {
      timeoutMs: settings.requestTimeoutMs,
      maxAttempts: settings.maxAttempts,
    };

    const attempt = async (
      hooks: GatewayHooks,
    ): Promise<{ result: SubRequestSuccess; warnings: string[] }> => {
      const gateway = options.pool.gateway(settings.agnesBaseUrl, hooks, gatewayOptions);
      const result = await gateway.generate(agnesPayload(parsed, preferredMode));
      const normalized = normalizeAgnesResponse(result.body, parsed);
      const measured = await measureOutputImages(normalized.images, options.fetchImpl);
      if (measured.first) normalized.body.size = formatPixel(measured.first);
      const mime = measured.mimes[0] ?? null;
      if (mime) normalized.body.output_format = mime.split("/")[1];
      else delete normalized.body.output_format;
      normalized.warnings.push(...measured.warnings);
      return {
        result: {
          status: result.status,
          account: result.account,
          normalized,
          actualSizes: measured.sizes,
        },
        warnings: normalized.warnings,
      };
    };

    const runOnce = async (): Promise<SubRequestOutcome> => {
      const traces: AttemptTrace[] = [];
      const hooks: GatewayHooks = {
        onAccountUsed(account, meta) {
          traces.push(attemptTrace(account, null, meta.durationMs));
        },
        onAttemptFailed(account, error, meta) {
          traces.push(attemptTrace(account, error, meta.durationMs));
        },
      };

      try {
        const outcome = await attempt(hooks);

        try {
          await options.store.recordUpstreamSuccess(
            outcome.result.account.id,
            outcome.result.normalized.images.length,
          );
        } catch (error) {
          console.error("account usage bookkeeping failed:", error);
        }

        try {
          await options.archiver.archive({
            ts: now().toISOString(),
            endpoint: parsed.endpoint,
            model: parsed.model,
            accountId: outcome.result.account.id,
            accountName: outcome.result.account.name,
            prompt: parsed.prompt,
            size: formatPixel(parsed.size.pixel),
            tier: parsed.size.tier,
            ratio: parsed.size.derivedRatio,
            images: outcome.result.normalized.images,
          });
        } catch (error) {
          console.error("archive failed:", error);
        }

        return { ok: true, result: outcome.result, traces };
      } catch (error) {
        if (
          traces.length === 0 && error instanceof ApiError &&
          error.code === "no_available_accounts"
        ) {
          traces.push({
            accountId: null,
            accountName: null,
            status: 503,
            code: "no_available_accounts",
            durationMs: 0,
            message: null,
          });
        }
        return { ok: false, error, traces };
      }
    };

    const outcomes = await Promise.all(
      Array.from({ length: parsed.n }, () => runOnce()),
    );

    const successes: SubRequestSuccess[] = [];
    const failures: unknown[] = [];
    const attempts: SubRequestTrace[] = outcomes.map((outcome, index) => ({
      index,
      traces: outcome.traces,
    }));

    for (const outcome of outcomes) {
      if (outcome.ok) successes.push(outcome.result);
      else failures.push(outcome.error);
    }

    const sizeRequest = formatRequestSize(parsed.size);

    if (successes.length === 0) {
      const selected = selectFailure(failures, failures.length, { prefix: false });
      await writeLog(
        {
          requestId,
          stage: "dispatch",
          status: selected.status,
          ok: false,
          requested: parsed.n,
          images: 0,
          failed: failures.length,
          sizeRequest,
          sizeActual: null,
          errorCode: selected.code ?? "invalid_request",
          error: selected.message,
          attempts,
        },
        parsed,
        path,
        startedAt,
        null,
      );
      throw selected;
    }

    const merged = mergeNormalizedResponses(successes.map((success) => success.normalized));
    const firstActual = successes[0]?.actualSizes[0] ?? null;
    merged.body.size = formatPixel(firstActual ?? parsed.size.pixel);
    const uniqueSizes = [
      ...new Set(
        successes
          .flatMap((success) => success.actualSizes)
          .filter((size): size is PixelSize => size !== null)
          .map(formatPixel),
      ),
    ];
    const logSize = uniqueSizes.length > 0 ? uniqueSizes.join(",") : null;
    const headers = new Headers();
    headers.set("content-type", JSON_TYPE);
    headers.set("x-agnes-requested", String(parsed.n));
    headers.set("x-agnes-succeeded", String(successes.length));
    headers.set("x-agnes-failed", String(failures.length));
    headers.set("x-agnes-resolved-size", formatRequestSize(parsed.size));
    if (failures.length > 0) {
      const statuses = [...new Set(failures.map((failure) => errorStatus(failure)))];
      headers.set("x-agnes-failure-statuses", statuses.join(","));
    }

    const warnings = [...parsed.warnings, ...merged.warnings];
    if (failures.length > 0) warnings.push("partial-success");
    addWarnings(headers, warnings);

    const ok = failures.length === 0;
    await writeLog(
      {
        requestId,
        stage: "complete",
        status: 200,
        ok,
        requested: parsed.n,
        images: merged.images.length,
        failed: failures.length,
        sizeRequest,
        sizeActual: logSize,
        errorCode: failures.length > 0 ? "partial_success" : null,
        error: failures.length > 0
          ? failures.map((failure) => errorMessage(failure)).join("; ")
          : null,
        attempts,
      },
      parsed,
      path,
      startedAt,
      successes[0].account,
    );

    return jsonResponse(merged.body, { status: 200, headers });
  }

  async function handleDataPlane(
    request: Request,
    path: string,
    startedAt: number,
    requestId: string,
  ): Promise<Response> {
    if (path === "/v1/models") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(["GET", "HEAD"]);
      }
      const models = imageModelList().map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "agnes",
      }));
      return jsonResponse({ object: "list", data: models });
    }

    if (
      path === "/v1/images/generations" || path === "/v1/images/edits" || path === "/v1/images/edit"
    ) {
      if (request.method !== "POST") return methodNotAllowed(["POST"]);
      if (!authorized(request)) {
        return errorResponse(
          new ApiError(401, "invalid API key", "invalid_request_error", null, "invalid_api_key"),
        );
      }

      const settings = await options.settings.read();
      const defaults = parseJsonOrDefaults(settings);
      const endpoint: ImageEndpoint = path === "/v1/images/generations" ? "generations" : "edits";
      const contentType = request.headers.get("content-type") ?? "";

      let parsed: ParsedImageRequest;
      try {
        if (endpoint === "edits" && contentType.toLowerCase().startsWith("multipart/form-data")) {
          parsed = await parseImageRequestMultipart(request, defaults, {
            fetchImpl: options.fetchImpl,
          });
        } else {
          if (
            endpoint === "generations" &&
            contentType.toLowerCase().startsWith("multipart/form-data")
          ) {
            throw new ApiError(
              400,
              "generations requires an application/json body",
              "invalid_request_error",
              null,
              "unsupported_content_type",
            );
          }
          parsed = await parseImageRequestJson(
            await readJsonBody(request),
            endpoint,
            defaults,
            undefined,
            {
              fetchImpl: options.fetchImpl,
            },
          );
        }
      } catch (error) {
        await writeParseFailure(requestId, endpoint, path, startedAt, error);
        throw error;
      }

      return await handleImageRequest(parsed, settings, path, startedAt, requestId);
    }

    throw new ApiError(404, "not found", "invalid_request_error", null, "unknown_path");
  }

  return async function handler(request: Request): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    if (request.method === "OPTIONS") {
      const origin = request.headers.get("origin");
      if (origin && corsAllowed.includes(origin)) {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": origin,
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "authorization, content-type",
            "access-control-max-age": "600",
            "vary": "Origin",
          },
        });
      }
      return new Response(null, { status: 204 });
    }

    if (path === "/") {
      return new Response(null, { status: 302, headers: { location: "/admin" } });
    }

    if (path === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(["GET", "HEAD"]);
      }
      if (url.searchParams.get("deep") === "1" && options.readyCheck) {
        try {
          await options.readyCheck();
        } catch (error) {
          console.error("deep health check failed:", error);
          return errorResponse(
            new ApiError(
              503,
              "database unavailable",
              "server_error",
              null,
              "database_unavailable",
            ),
          );
        }
      }
      return jsonResponse({ status: "ok" });
    }

    if (path === "/admin") {
      try {
        if (await hasAdminAccess(request)) {
          return htmlResponse(renderAdminPage());
        }
        return htmlResponse(renderLoginPage());
      } catch (error) {
        return errorResponse(error);
      }
    }

    if (path.startsWith("/admin/")) {
      if (options.admin.matches(path)) {
        return await options.admin.handle(request, path);
      }
      return errorResponse(
        new ApiError(404, "not found", "invalid_request_error", null, "unknown_path"),
      );
    }

    if (path.startsWith("/v1/")) {
      const isImagePath = path === "/v1/images/generations" || path === "/v1/images/edits" ||
        path === "/v1/images/edit";
      const requestId = isImagePath ? crypto.randomUUID() : null;
      const response = await (async () => {
        try {
          return await handleDataPlane(request, path, startedAt, requestId ?? "");
        } catch (error) {
          return errorResponse(error);
        }
      })();
      const final = applyCors(request, response);
      if (requestId) final.headers.set("x-request-id", requestId);
      return final;
    }

    return errorResponse(
      new ApiError(404, "not found", "invalid_request_error", null, "unknown_path"),
    );
  };
}
