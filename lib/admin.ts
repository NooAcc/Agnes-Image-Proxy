import type { AccountRecord, AccountStore, AccountSummary } from "./accounts.ts";
import { maskKey } from "./accounts.ts";
import type { SessionService } from "./auth.ts";
import { readCookie, timingSafeEqual } from "./auth.ts";
import type { Enricher } from "./enrich.ts";
import { ApiError } from "./errors.ts";
import type { GalleryStore, GalleryTagFilter } from "./gallery.ts";
import {
  asObject,
  bytesResponse,
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  noStore,
  readJsonBody,
} from "./http.ts";
import {
  GALLERY_PAGE_MAX,
  GALLERY_PAGE_SIZE,
  IMAGE_SERVICE_BATCH_SOURCE_BYTES,
  IMAGE_SERVICE_MAX_ITEMS,
  IMAGE_SERVICE_MAX_SOURCE_BYTES,
  LOG_LIST_LIMIT,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_WINDOW_MS,
  OVERVIEW_TREND_DAYS,
  SESSION_TTL_MS,
} from "./limits.ts";
import type { RequestLogStore } from "./logs.ts";
import { imageModelList } from "./model-catalog.ts";
import type { ModelUsageStore } from "./model-usage.ts";
import { type AgnesClientFactory, cappedCooldownMs, classifyFailure } from "./pool.ts";
import { type AppSettings, type SettingsStore, validateSettings } from "./settings.ts";

export const SESSION_PATH = "/admin/api/session";
export const SESSION_REVOKE_PATH = "/admin/api/session/revoke";
export const SESSION_COOKIE = "agnes_session";

const ACCOUNT_ITEM = /^\/admin\/api\/accounts\/(\d+)$/;
const ACCOUNT_TEST = /^\/admin\/api\/accounts\/(\d+)\/test$/;
const ACCOUNT_RESET = /^\/admin\/api\/accounts\/(\d+)\/reset$/;
const GALLERY_PATH = /^\/admin\/api\/gallery(?:\/\d+(?:\/content|\/thumbnail)?)?$/;
const GALLERY_TAGS = new Set<GalleryTagFilter>([
  "neutral",
  "drawing",
  "sexy",
  "porn",
  "hentai",
  "uncategorized",
]);
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface AdminApiOptions {
  store: AccountStore;
  settings: SettingsStore;
  logs: RequestLogStore;
  modelUsage: ModelUsageStore;
  gallery: GalleryStore;
  apiKey: string;
  session: SessionService;
  createClient: AgnesClientFactory;
  enricher?: Enricher;
  now?: () => Date;
}

export interface AdminApi {
  matches(path: string): boolean;
  handle(request: Request, path: string): Promise<Response>;
}

export function sessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
  now: Date,
): string {
  const expires = new Date(now.getTime() + maxAgeSeconds * 1000).toUTCString();
  let cookie = `${SESSION_COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${maxAgeSeconds}; Expires=${expires}`;
  if (secure) cookie += "; Secure";
  return cookie;
}

function summaryOf(record: AccountRecord): AccountSummary {
  const { apiKey, ...rest } = record;
  return { ...rest, apiKeyMasked: maskKey(apiKey) };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shiftDay(day: string, offsetDays: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function createLoginLimiter(now: () => Date) {
  let windowStart = now().getTime();
  let failures = 0;
  const roll = () => {
    const stamp = now().getTime();
    if (stamp - windowStart >= LOGIN_RATE_WINDOW_MS) {
      windowStart = stamp;
      failures = 0;
    }
  };
  return {
    blocked(): boolean {
      roll();
      return failures >= LOGIN_RATE_LIMIT;
    },
    recordFailure(): void {
      roll();
      failures++;
    },
    reset(): void {
      failures = 0;
      windowStart = now().getTime();
    },
  };
}

export function createAdminApi(options: AdminApiOptions): AdminApi {
  const now = options.now ?? (() => new Date());
  const settings: SettingsStore = options.settings;
  const loginLimiter = createLoginLimiter(now);

  const matches = (path: string): boolean =>
    path === SESSION_PATH ||
    path === SESSION_REVOKE_PATH ||
    path === "/admin/api/accounts" ||
    path === "/admin/api/accounts/test" ||
    path === "/admin/api/accounts/import" ||
    path === "/admin/api/settings" ||
    path === "/admin/api/logs" ||
    path === "/admin/api/overview" ||
    path === "/admin/api/gallery/enrich" ||
    ACCOUNT_ITEM.test(path) ||
    ACCOUNT_TEST.test(path) ||
    ACCOUNT_RESET.test(path) ||
    GALLERY_PATH.test(path);

  const authorized = async (
    request: Request,
  ): Promise<{ ok: boolean; viaCookie: boolean; token: string | null }> => {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match && timingSafeEqual(match[1].trim(), options.apiKey)) {
      return { ok: true, viaCookie: false, token: null };
    }
    const token = readCookie(request, SESSION_COOKIE);
    if (!token) return { ok: false, viaCookie: false, token: null };
    const claims = await options.session.verify(token, now());
    return { ok: claims !== null, viaCookie: true, token };
  };

  const unauthorized = () =>
    errorResponse(new ApiError(401, "unauthorized", "invalid_request_error", null, "unauthorized"));

  const handleSession = async (request: Request): Promise<Response> => {
    if (request.method === "POST") {
      if (loginLimiter.blocked()) {
        return errorResponse(
          new ApiError(
            429,
            "too many login attempts; try again in 60 seconds",
            "rate_limit_error",
            null,
            "rate_limit_exceeded",
            { "retry-after": "60" },
          ),
        );
      }
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        throw new ApiError(400, "invalid login body", "invalid_request_error");
      }
      const key = asObject(body)?.key;
      if (typeof key !== "string" || !timingSafeEqual(key, options.apiKey)) {
        loginLimiter.recordFailure();
        return errorResponse(
          new ApiError(401, "invalid API key", "invalid_request_error", null, "invalid_api_key"),
        );
      }
      loginLimiter.reset();
      const token = await options.session.issue(now());
      const secure = new URL(request.url).protocol === "https:";
      return new Response(null, {
        status: 204,
        headers: {
          "set-cookie": sessionCookie(token, SESSION_TTL_MS / 1000, secure, now()),
        },
      });
    }

    if (request.method === "DELETE") {
      const secure = new URL(request.url).protocol === "https:";
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": sessionCookie("", 0, secure, now()) },
      });
    }

    return methodNotAllowed(["POST", "DELETE"]);
  };

  const probeAccount = async (
    record: AccountRecord,
    current: AppSettings,
  ): Promise<Record<string, unknown>> => {
    try {
      const client = options.createClient({
        baseUrl: current.agnesBaseUrl,
        apiKey: record.apiKey,
        timeoutMs: current.requestTimeoutMs,
      });
      await client.generate({
        path: "/images/generations",
        body: {
          model: current.probeModel,
          prompt: "ping",
          size: "1K",
          ratio: "1:1",
          extra_body: { response_format: "url" },
        },
      });
      await options.store.markHealthy(record.id, record.failCount);
      return { ok: true, account: summaryOf(record) };
    } catch (error) {
      const classification = classifyFailure(error);
      if (classification.accountProblem) {
        try {
          await options.store.recordFailure(record.id, cappedCooldownMs(error));
        } catch (bookkeepingError) {
          console.error("probe bookkeeping failed:", bookkeepingError);
        }
      }
      return {
        ok: false,
        account: summaryOf(record),
        status: error instanceof ApiError ? error.status : 500,
        error: message(error),
      };
    }
  };

  const handleAccounts = async (request: Request): Promise<Response> => {
    if (request.method === "GET") {
      return jsonResponse(await options.store.list());
    }
    if (request.method === "POST") {
      const body = asObject(await readJsonBody(request));
      const name = typeof body?.name === "string" ? body.name : "";
      const apiKey = typeof body?.apiKey === "string" ? body.apiKey : "";
      const created = await options.store.create({ name, apiKey });
      return jsonResponse(summaryOf(created), { status: 201 });
    }
    return methodNotAllowed(["GET", "POST"]);
  };

  const handleAccountItem = async (
    request: Request,
    id: number,
  ): Promise<Response> => {
    if (request.method === "PATCH") {
      const body = asObject(await readJsonBody(request)) ?? {};
      const patch: { name?: string; enabled?: boolean; apiKey?: string } = {};
      if (typeof body.name === "string") patch.name = body.name;
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.apiKey === "string") patch.apiKey = body.apiKey;
      return jsonResponse(summaryOf(await options.store.update(id, patch)));
    }
    if (request.method === "DELETE") {
      const removed = await options.store.remove(id);
      if (!removed) throw new ApiError(404, "account not found", "invalid_request_error", "id");
      return new Response(null, { status: 204 });
    }
    return methodNotAllowed(["PATCH", "DELETE"]);
  };

  const handleAccountTest = async (request: Request, id: number): Promise<Response> => {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const record = await options.store.get(id);
    if (!record) throw new ApiError(404, "account not found", "invalid_request_error", "id");
    return jsonResponse(await probeAccount(record, await settings.read()));
  };

  const handleAccountReset = async (request: Request, id: number): Promise<Response> => {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const reset = await options.store.resetHealth(id);
    if (!reset) throw new ApiError(404, "account not found", "invalid_request_error", "id");
    const record = await options.store.get(id);
    return jsonResponse(record ? summaryOf(record) : null);
  };

  const handleTestAll = async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const current = await settings.read();
    const enabled = (await options.store.list()).filter((account) => account.enabled);
    const records: AccountRecord[] = [];
    for (const account of enabled) {
      const record = await options.store.get(account.id);
      if (record) records.push(record);
    }
    const results = await mapLimit(
      records,
      current.probeConcurrency,
      (record) => probeAccount(record, current),
    );
    return jsonResponse({ results });
  };

  const handleImport = async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const body = asObject(await readJsonBody(request));
    const text = typeof body?.text === "string" ? body.text : "";
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
    const results: Record<string, unknown>[] = [];
    for (const line of lines) {
      const comma = line.indexOf(",");
      const name = comma === -1 ? "" : line.slice(0, comma).trim();
      const apiKey = comma === -1 ? "" : line.slice(comma + 1).trim();
      if (name === "" || apiKey === "") {
        results.push({ line, ok: false, error: "expected name,key" });
        continue;
      }
      try {
        const created = await options.store.create({ name, apiKey });
        results.push({ line, ok: true, account: summaryOf(created) });
      } catch (error) {
        results.push({ line, ok: false, error: message(error) });
      }
    }
    return jsonResponse({ results });
  };

  const handleSettings = async (request: Request): Promise<Response> => {
    if (request.method === "GET") return jsonResponse(await settings.read());
    if (request.method === "PUT") {
      const body = asObject(await readJsonBody(request));
      if (!body) {
        throw new ApiError(
          400,
          "settings must be an object",
          "invalid_request_error",
          null,
          "invalid_setting",
        );
      }
      const next = validateSettings({ ...(await settings.read()), ...body });
      await settings.write(next);
      return jsonResponse(next);
    }
    return methodNotAllowed(["GET", "PUT"]);
  };

  const handleLogs = async (request: Request): Promise<Response> => {
    if (request.method === "GET") return jsonResponse(await options.logs.list(LOG_LIST_LIMIT));
    if (request.method === "DELETE") {
      await options.logs.clear();
      return new Response(null, { status: 204 });
    }
    return methodNotAllowed(["GET", "DELETE"]);
  };

  const handleGallery = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET") {
      const rawLimit = url.searchParams.get("limit");
      let limit = GALLERY_PAGE_SIZE;
      if (rawLimit !== null) {
        const parsed = Number(rawLimit);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > GALLERY_PAGE_MAX) {
          throw new ApiError(
            400,
            `limit must be an integer between 1 and ${GALLERY_PAGE_MAX}`,
            "invalid_request_error",
            "limit",
          );
        }
        limit = parsed;
      }
      const rawBefore = url.searchParams.get("before");
      let before: number | null = null;
      if (rawBefore !== null) {
        const parsed = Number(rawBefore);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new ApiError(
            400,
            "before must be a positive integer",
            "invalid_request_error",
            "before",
          );
        }
        before = parsed;
      }
      const rawTag = url.searchParams.get("tag");
      let tag: GalleryTagFilter | null = null;
      if (rawTag !== null) {
        if (!GALLERY_TAGS.has(rawTag as GalleryTagFilter)) {
          throw new ApiError(
            400,
            `tag must be one of ${[...GALLERY_TAGS].join(", ")}`,
            "invalid_request_error",
            "tag",
          );
        }
        tag = rawTag as GalleryTagFilter;
      }
      return jsonResponse(await options.gallery.list(before, limit, tag));
    }
    if (request.method === "DELETE") {
      await options.gallery.clear();
      return new Response(null, { status: 204 });
    }
    return methodNotAllowed(["GET", "DELETE"]);
  };

  const handleGalleryContent = async (request: Request, id: number): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(["GET", "HEAD"]);
    }
    const content = await options.gallery.content(id);
    if (!content) {
      throw new ApiError(404, "image not found", "invalid_request_error", "id");
    }
    return bytesResponse(content.bytes, content.mime);
  };

  const handleGalleryThumbnail = async (request: Request, id: number): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(["GET", "HEAD"]);
    }
    const thumbnail = await options.gallery.thumbnail(id);
    if (!thumbnail) {
      throw new ApiError(404, "image not found", "invalid_request_error", "id");
    }
    return bytesResponse(thumbnail.bytes, thumbnail.mime);
  };

  const handleGalleryEnrich = async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const enricher = options.enricher;
    if (!enricher || !(await enricher.enabled())) {
      throw new ApiError(
        400,
        "image service is not configured",
        "invalid_request_error",
        null,
        "image_service_disabled",
      );
    }

    let before: number | null = null;
    const text = await request.text();
    if (text.trim() !== "") {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new ApiError(400, "request body is not valid JSON", "invalid_request_error");
      }
      const object = asObject(body);
      if (!object) {
        throw new ApiError(400, "request body must be a JSON object", "invalid_request_error");
      }
      if (object.before !== undefined && object.before !== null) {
        const value = object.before;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
          throw new ApiError(
            400,
            "before must be a positive integer",
            "invalid_request_error",
            "before",
          );
        }
        before = value;
      }
    }

    const rows = await options.gallery.pendingEnrichment(before, IMAGE_SERVICE_MAX_ITEMS);
    const at = now().toISOString();
    let oversized = 0;
    let attemptedCount = 0;
    let budget = 0;
    const eligibleIds: number[] = [];
    for (const row of rows) {
      if (row.byteSize > IMAGE_SERVICE_MAX_SOURCE_BYTES) {
        oversized++;
        attemptedCount++;
        try {
          await options.gallery.setEnrichment(row.id, {
            thumb: null,
            thumbMime: null,
            nsfw: null,
            tag: null,
            status: "failed",
            error: "source exceeds 50 MiB",
            at,
          });
        } catch (error) {
          console.error("image enrichment write failed:", error);
        }
        continue;
      }
      if (
        eligibleIds.length > 0 &&
        budget + row.byteSize > IMAGE_SERVICE_BATCH_SOURCE_BYTES
      ) {
        break;
      }
      eligibleIds.push(row.id);
      budget += row.byteSize;
      attemptedCount++;
    }

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    if (eligibleIds.length > 0) {
      const inputs = await options.gallery.readForEnrichment(eligibleIds);
      if (inputs.length > 0) {
        const report = await enricher.enrich(inputs);
        processed = report.processed;
        succeeded = report.succeeded;
        failed = report.failed;
      }
    }

    const nextBefore = rows.length === 0 ||
        (attemptedCount === rows.length && rows.length < IMAGE_SERVICE_MAX_ITEMS)
      ? null
      : rows[attemptedCount - 1].id;

    return jsonResponse({
      processed: oversized + processed,
      succeeded,
      failed: oversized + failed,
      remaining: await options.gallery.countPendingEnrichment(),
      nextBefore,
    });
  };

  const handleGalleryItem = async (request: Request, id: number): Promise<Response> => {
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    const removed = await options.gallery.remove(id);
    if (!removed) {
      throw new ApiError(404, "image not found", "invalid_request_error", "id");
    }
    return new Response(null, { status: 204 });
  };

  const handleOverview = async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const url = new URL(request.url);
    const day = url.searchParams.get("day") ?? now().toISOString().slice(0, 10);
    const parsedDay = new Date(`${day}T00:00:00Z`);
    if (
      !DAY_PATTERN.test(day) || Number.isNaN(parsedDay.getTime()) ||
      parsedDay.toISOString().slice(0, 10) !== day
    ) {
      throw new ApiError(400, "day must be YYYY-MM-DD", "invalid_request_error", "day");
    }

    const usage = await options.modelUsage.byDay(day);
    const models = imageModelList().map((id) => {
      const row = usage.get(id);
      return {
        id,
        requests: row?.requests ?? 0,
        successes: row?.successes ?? 0,
        partials: row?.partials ?? 0,
        failures: row?.failures ?? 0,
        images: row?.images ?? 0,
        lastUsedAt: row?.lastUsedAt ?? null,
      };
    });
    for (const [model, row] of usage) {
      if (models.some((item) => item.id === model)) continue;
      models.push({
        id: model,
        requests: row.requests,
        successes: row.successes,
        partials: row.partials,
        failures: row.failures,
        images: row.images,
        lastUsedAt: row.lastUsedAt,
      });
    }

    const totals = models.reduce(
      (accumulator, model) => ({
        requests: accumulator.requests + model.requests,
        successes: accumulator.successes + model.successes,
        partials: accumulator.partials + model.partials,
        failures: accumulator.failures + model.failures,
        images: accumulator.images + model.images,
      }),
      { requests: 0, successes: 0, partials: 0, failures: 0, images: 0 },
    );

    const accounts = await options.store.list();

    const range = await options.modelUsage.byRange(
      shiftDay(day, -(OVERVIEW_TREND_DAYS - 1)),
      day,
    );
    const trend = Array.from({ length: OVERVIEW_TREND_DAYS }, (_, index) => {
      const dayKey = shiftDay(day, index - (OVERVIEW_TREND_DAYS - 1));
      const row = range.get(dayKey);
      return {
        day: dayKey,
        requests: row?.requests ?? 0,
        successes: row?.successes ?? 0,
        partials: row?.partials ?? 0,
        failures: row?.failures ?? 0,
        images: row?.images ?? 0,
      };
    });

    return jsonResponse({
      day,
      totals,
      accounts: {
        total: accounts.length,
        enabled: accounts.filter((account) => account.enabled).length,
        healthy: accounts.filter((account) => account.enabled && account.status === "healthy")
          .length,
        degraded: accounts.filter((account) => account.status === "degraded").length,
      },
      settings: await settings.read(),
      models,
      trend,
    });
  };

  const handleSessionRevoke = async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    await options.session.revokeAll(now());
    const secure = new URL(request.url).protocol === "https:";
    return new Response(null, {
      status: 204,
      headers: { "set-cookie": sessionCookie("", 0, secure, now()) },
    });
  };

  const route = async (request: Request, path: string): Promise<Response> => {
    if (path === SESSION_REVOKE_PATH) return await handleSessionRevoke(request);
    if (path === "/admin/api/accounts") return await handleAccounts(request);
    if (path === "/admin/api/accounts/test") return await handleTestAll(request);
    if (path === "/admin/api/accounts/import") return await handleImport(request);
    if (path === "/admin/api/settings") return await handleSettings(request);
    if (path === "/admin/api/logs") return await handleLogs(request);
    if (path === "/admin/api/overview") return await handleOverview(request);
    if (path === "/admin/api/gallery") return await handleGallery(request);
    if (path === "/admin/api/gallery/enrich") return await handleGalleryEnrich(request);

    const galleryContent = /^\/admin\/api\/gallery\/(\d+)\/content$/.exec(path);
    if (galleryContent) {
      return await handleGalleryContent(request, Number(galleryContent[1]));
    }
    const galleryThumbnail = /^\/admin\/api\/gallery\/(\d+)\/thumbnail$/.exec(path);
    if (galleryThumbnail) {
      return await handleGalleryThumbnail(request, Number(galleryThumbnail[1]));
    }
    const galleryItem = /^\/admin\/api\/gallery\/(\d+)$/.exec(path);
    if (galleryItem) return await handleGalleryItem(request, Number(galleryItem[1]));

    const item = ACCOUNT_ITEM.exec(path);
    if (item) return await handleAccountItem(request, Number(item[1]));
    const test = ACCOUNT_TEST.exec(path);
    if (test) return await handleAccountTest(request, Number(test[1]));
    const reset = ACCOUNT_RESET.exec(path);
    if (reset) return await handleAccountReset(request, Number(reset[1]));

    throw new ApiError(404, "not found", "invalid_request_error", null, "unknown_path");
  };

  return {
    matches,

    async handle(request, path) {
      if (!matches(path)) {
        throw new ApiError(404, "not found", "invalid_request_error", null, "unknown_path");
      }

      if (path === SESSION_PATH) {
        try {
          return noStore(await handleSession(request));
        } catch (error) {
          return noStore(errorResponse(error));
        }
      }

      try {
        const auth = await authorized(request);
        if (!auth.ok) return noStore(unauthorized());

        let response: Response;
        try {
          response = await route(request, path);
        } catch (error) {
          response = errorResponse(error);
        }

        // Sliding renewal only for cookie-authenticated admin API calls.
        if (auth.viaCookie && auth.token) {
          try {
            const renewed = await options.session.renew(auth.token, now());
            const claims = renewed ? await options.session.verify(renewed, now()) : null;
            if (renewed && claims) {
              const maxAge = Math.max(0, Math.ceil((claims.exp - now().getTime()) / 1000));
              const secure = new URL(request.url).protocol === "https:";
              response.headers.append(
                "set-cookie",
                sessionCookie(renewed, maxAge, secure, now()),
              );
            }
          } catch (error) {
            console.error("session renewal failed:", error);
          }
        }

        return noStore(response);
      } catch (error) {
        return noStore(errorResponse(error));
      }
    },
  };
}
