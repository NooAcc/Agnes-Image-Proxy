import type {
  AccountSummary,
  BackfillStatus,
  GalleryItem,
  Overview,
  Page,
  RequestLog,
  Settings,
} from "@/lib/contracts";
import { errorResponse, jsonResponse, type MockHandler, type MockRequest } from "./server";

export interface AdminError {
  status: number;
  message: string;
  param?: string | null;
  code?: string | null;
}

export interface AdminState {
  authenticated: boolean;
  accounts: AccountSummary[];
  settings: Settings;
  logs: RequestLog[];
  overview: Overview;
  gallery: Page<GalleryItem>;
  backfill: BackfillStatus;
  nextID: number;
  settingsError: AdminError | null;
  probeStatus: number;
  importFailures: Set<number>;
  images: Map<number, string>;
  thumbnails: Map<number, string>;
}

export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    agnesBaseUrl: "https://apihub.agnes-ai.com/v1",
    defaultSize: "1K",
    imageParamMode: "nested",
    probeModel: "agnes-image-2.5-flash",
    probeConcurrency: 2,
    requestTimeoutMs: 300_000,
    autoRefreshIntervalMs: 5_000,
    maxAttempts: 3,
    imageServiceBaseUrl: "",
    thumbnailWidth: 640,
    thumbnailQuality: 75,
    enrichTimeoutMs: 60_000,
    ...overrides,
  };
}

export function makeAccount(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: 1,
    name: "primary",
    apiKeyMasked: "sk-p…cdef",
    enabled: true,
    status: "healthy",
    cooldownUntil: null,
    failCount: 0,
    lastUsedAt: null,
    upstreamRequests: 0,
    upstreamImages: 0,
    createdAt: "2026-11-24T09:00:00Z",
    ...overrides,
  };
}

export function makeLog(overrides: Partial<RequestLog> = {}): RequestLog {
  return {
    id: 1,
    requestId: "req-1",
    ts: "2026-11-24T10:00:00Z",
    category: "request",
    stage: "complete",
    endpoint: "generations",
    path: "/v1/images/generations",
    model: "agnes-image-2.5-flash",
    status: 200,
    ok: true,
    requested: 1,
    images: 1,
    failed: 0,
    durationMs: 1200,
    sizeRequest: "1K",
    sizeActual: "1024x1024",
    attempts: [],
    ...overrides,
  };
}

export function makeOverview(overrides: Partial<Overview> = {}): Overview {
  return {
    startDay: "2026-11-18",
    endDay: "2026-11-24",
    totals: { requests: 0, successes: 0, partials: 0, failures: 0, images: 0 },
    days: [],
    models: [],
    accounts: { total: 0, healthy: 0, cooling: 0, disabled: 0 },
    ...overrides,
  };
}

export function createAdminState(overrides: Partial<AdminState> = {}): AdminState {
  return {
    authenticated: true,
    accounts: [],
    settings: makeSettings(),
    logs: [],
    overview: makeOverview(),
    gallery: { items: [], nextBefore: null },
    backfill: {
      running: false,
      startedAt: null,
      finishedAt: null,
      processed: 0,
      succeeded: 0,
      failed: 0,
      error: null,
    },
    nextID: 1,
    settingsError: null,
    probeStatus: 200,
    importFailures: new Set(),
    images: new Map(),
    thumbnails: new Map(),
    ...overrides,
  };
}

function segments(request: MockRequest): string[] {
  return request.path.replace(/^\/admin\/api\/?/, "").split("/").filter(Boolean);
}

function bodyOf<T>(request: MockRequest): T {
  return (request.body ?? {}) as T;
}

function getStateNumber(raw: string | undefined): number {
  return Number(raw);
}

// adminHandlers is an in-memory backend matching the Go admin contract.
export function adminHandlers(state: AdminState): MockHandler[] {
  return [
    // Session
    (request) => {
      const parts = segments(request);
      if (parts[0] !== "session") return undefined;
      if (parts.length === 1 && request.method === "GET") {
        return state.authenticated ? jsonResponse({ authenticated: true }) : errorResponse(401, "authentication required");
      }
      if (parts.length === 1 && request.method === "POST") {
        const body = bodyOf<{ apiKey?: string }>(request);
        if (body.apiKey === "secret-key") {
          state.authenticated = true;
          return jsonResponse(
            { authenticated: true },
            200,
            { "Set-Cookie": "agnes_session=test-token; Path=/admin; HttpOnly; SameSite=Lax" },
          );
        }
        return errorResponse(401, "invalid API key", null, "invalid_api_key");
      }
      if (parts.length === 1 && request.method === "DELETE") {
        state.authenticated = false;
        return new Response(null, { status: 204 });
      }
      if (parts[1] === "revoke" && request.method === "POST") {
        state.authenticated = false;
        return new Response(null, { status: 204 });
      }
      return undefined;
    },
    // Accounts
    (request) => {
      const parts = segments(request);
      if (parts[0] !== "accounts") return undefined;
      if (parts.length === 1 && request.method === "GET") {
        return jsonResponse({ items: state.accounts });
      }
      if (parts.length === 1 && request.method === "POST") {
        const body = bodyOf<{ name: string; apiKey: string }>(request);
        const account = makeAccount({
          id: state.nextID++,
          name: body.name,
          apiKeyMasked: "sk-••••",
        });
        state.accounts.push(account);
        return jsonResponse(account, 201);
      }
      if (parts[1] === "import" && request.method === "POST") {
        const body = bodyOf<{ accounts: { name: string; apiKey: string }[] }>(request);
        const errors: { index: number; message: string }[] = [];
        let imported = 0;
        body.accounts.forEach((entry, index) => {
          if (!entry.name || state.importFailures.has(index)) {
            errors.push({ index, message: "name must be non-empty" });
            return;
          }
          state.accounts.push(makeAccount({ id: state.nextID++, name: entry.name, apiKeyMasked: "sk-••••" }));
          imported++;
        });
        return jsonResponse({ imported, errors });
      }
      if (parts[1] === "test" && request.method === "POST") {
        return jsonResponse({
          items: state.accounts.map((account) => ({
            id: account.id,
            ok: state.probeStatus === 200,
            status: state.probeStatus,
            message: state.probeStatus === 200 ? "ok" : "probe failed",
          })),
        });
      }
      const id = getStateNumber(parts[1]);
      const index = state.accounts.findIndex((account) => account.id === id);
      if (parts.length === 2 && request.method === "PATCH") {
        if (index === -1) return errorResponse(404, "account not found", null, "account_not_found");
        const patch = bodyOf<{ name?: string; enabled?: boolean }>(request);
        const current = state.accounts[index];
        state.accounts[index] = {
          ...current,
          name: patch.name ?? current.name,
          enabled: patch.enabled ?? current.enabled,
          status: patch.enabled === false ? "disabled" : current.status,
        };
        return jsonResponse(state.accounts[index]);
      }
      if (parts.length === 2 && request.method === "DELETE") {
        if (index === -1) return errorResponse(404, "account not found", null, "account_not_found");
        state.accounts.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      if (parts[2] === "test" && request.method === "POST") {
        if (index === -1) return errorResponse(404, "account not found", null, "account_not_found");
        return jsonResponse({
          id,
          ok: state.probeStatus === 200,
          status: state.probeStatus,
          message: state.probeStatus === 200 ? "ok" : "probe failed",
        });
      }
      if (parts[2] === "reset" && request.method === "POST") {
        if (index === -1) return errorResponse(404, "account not found", null, "account_not_found");
        return new Response(null, { status: 204 });
      }
      return undefined;
    },
    // Settings
    (request) => {
      const parts = segments(request);
      if (parts[0] !== "settings" || parts.length !== 1) return undefined;
      if (request.method === "GET") {
        return jsonResponse(state.settings);
      }
      if (request.method === "PUT") {
        if (state.settingsError) {
          const issue = state.settingsError;
          return errorResponse(issue.status, issue.message, issue.param ?? null, issue.code ?? null);
        }
        state.settings = bodyOf<Settings>(request);
        return jsonResponse(state.settings);
      }
      return undefined;
    },
    // Logs
    (request) => {
      const parts = segments(request);
      if (parts[0] !== "logs" || parts.length !== 1) return undefined;
      if (request.method === "GET") {
        const category = request.search.get("category");
        const limit = Number(request.search.get("limit") ?? "50");
        const before = request.search.get("before");
        const items = state.logs
          .filter((log) => !category || log.category === category)
          .filter((log) => !before || log.id < Number(before))
          .sort((a, b) => b.id - a.id)
          .slice(0, limit);
        return jsonResponse({ items, nextBefore: null });
      }
      if (request.method === "DELETE") {
        state.logs = [];
        return new Response(null, { status: 204 });
      }
      return undefined;
    },
    // Overview
    (request) => {
      const parts = segments(request);
      if (parts[0] !== "overview" || parts.length !== 1 || request.method !== "GET") return undefined;
      return jsonResponse(state.overview);
    },
    // Gallery
    (request) => {
      const parts = segments(request);
      if (parts[0] !== "gallery") return undefined;
      if (parts.length === 1 && request.method === "GET") {
        const tag = request.search.get("tag");
        const before = request.search.get("before");
        const limit = Number(request.search.get("limit") ?? "24");
        const items = state.gallery.items
          .filter((item) => !tag || (tag === "unclassified" ? !item.nsfwTag || item.nsfwTag === "unclassified" : item.nsfwTag === tag))
          .filter((item) => !before || item.id < Number(before))
          .slice(0, limit);
        return jsonResponse({ items, nextBefore: null });
      }
      if (parts[1] === "enrich" && request.method === "GET") {
        return jsonResponse(state.backfill);
      }
      if (parts[1] === "enrich" && request.method === "POST") {
        state.backfill = { ...state.backfill, running: true };
        return jsonResponse(state.backfill, 202);
      }
      if (parts.length === 3 && (parts[2] === "content" || parts[2] === "thumbnail")) {
        if (request.method !== "GET") return undefined;
        const id = getStateNumber(parts[1]);
        const body = parts[2] === "content" ? state.images.get(id) : state.thumbnails.get(id);
        if (body === undefined) {
          return new Response("missing", { status: 404, headers: { "Content-Type": "text/plain" } });
        }
        return new Response(body, { status: 200, headers: { "Content-Type": "image/png" } });
      }
      if (parts.length === 2 && request.method === "DELETE") {
        const id = getStateNumber(parts[1]);
        const index = state.gallery.items.findIndex((item) => item.id === id);
        if (index === -1) return errorResponse(404, "gallery image not found", null, "not_found");
        state.gallery = { ...state.gallery, items: state.gallery.items.filter((item) => item.id !== id) };
        state.images.delete(id);
        state.thumbnails.delete(id);
        return new Response(null, { status: 204 });
      }
      if (parts.length === 1 && request.method === "DELETE") {
        state.gallery = { items: [], nextBefore: null };
        state.images.clear();
        state.thumbnails.clear();
        return new Response(null, { status: 204 });
      }
      return undefined;
    },
  ];
}
