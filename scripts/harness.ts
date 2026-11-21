import { type AccountStore, createAccountStore, ensureSchema } from "../lib/accounts.ts";
import { type AdminApi, createAdminApi } from "../lib/admin.ts";
import { type Archiver, createArchiver } from "../lib/archive.ts";
import { createAuthStateStore, createSessionService, type SessionService } from "../lib/auth.ts";
import { createHandler } from "../lib/app.ts";
import { createGalleryStore, type GalleryStore } from "../lib/gallery.ts";
import { createRequestLogStore, type RequestLogStore } from "../lib/logs.ts";
import { createModelUsageStore, type ModelUsageStore } from "../lib/model-usage.ts";
import { type AgnesClientFactory, createAccountPool } from "../lib/pool.ts";
import { createCachedSettings, createSettingsStore, type SettingsStore } from "../lib/settings.ts";
import { createSqlExecutor, type SqlExecutor } from "../lib/sql.ts";
import { renderAdminPage } from "../web/ui.ts";
import { renderLoginPage } from "../web/login.ts";

export interface HarnessOptions {
  apiKey: string;
  sql: SqlExecutor;
  createClient: AgnesClientFactory;
  archiver?: Archiver;
  corsAllowedOrigins?: string[];
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

export interface Harness {
  handler: (request: Request) => Promise<Response>;
  sql: SqlExecutor;
  store: AccountStore;
  settings: SettingsStore;
  logs: RequestLogStore;
  modelUsage: ModelUsageStore;
  gallery: GalleryStore;
  session: SessionService;
  api: AdminApi;
}

/** Reads a database URL into a SqlExecutor (production: Turso/libSQL). */
export function openDatabase(options: { url: string; authToken: string }): SqlExecutor {
  return createSqlExecutor({ url: options.url, authToken: options.authToken });
}

/** Shared assembly used by main.ts, the preview server and the tests. */
export async function buildHarness(options: HarnessOptions): Promise<Harness> {
  await ensureSchema(options.sql);

  const store = createAccountStore(options.sql);
  const settings = createCachedSettings(createSettingsStore(options.sql));
  const logs = createRequestLogStore(options.sql);
  const modelUsage = createModelUsageStore(options.sql);
  const gallery = createGalleryStore(options.sql);
  const session = createSessionService(options.apiKey, createAuthStateStore(options.sql));
  const archiver = options.archiver ?? createArchiver({ gallery });
  const pool = createAccountPool({ store, createClient: options.createClient });
  const api = createAdminApi({
    store,
    settings,
    logs,
    modelUsage,
    gallery,
    apiKey: options.apiKey,
    session,
    createClient: options.createClient,
    now: options.now,
  });

  const handler = createHandler({
    pool,
    store,
    settings,
    admin: api,
    logs,
    modelUsage,
    archiver,
    apiKey: options.apiKey,
    session,
    renderAdminPage,
    renderLoginPage,
    corsAllowedOrigins: options.corsAllowedOrigins,
    readyCheck: async () => {
      await options.sql.execute("SELECT 1");
    },
    now: options.now,
    fetchImpl: options.fetchImpl,
  });

  return { handler, sql: options.sql, store, settings, logs, modelUsage, gallery, session, api };
}
