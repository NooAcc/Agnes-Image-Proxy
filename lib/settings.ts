import { ApiError } from "./errors.ts";
import { executeBatch, type SqlExecutor } from "./sql.ts";
import { SETTINGS_CACHE_TTL_MS } from "./limits.ts";
import { isSizeTier, type SizeTier } from "./size.ts";

export type ResponseFormat = "b64_json" | "url";
export type ImageParamMode = "auto" | "nested" | "top_level";

export interface AppSettings {
  agnesBaseUrl: string;
  defaultResponseFormat: ResponseFormat;
  defaultSize: SizeTier;
  imageParamMode: ImageParamMode;
  probeModel: string;
  probeConcurrency: number;
  requestTimeoutMs: number;
  autoRefreshIntervalMs: number;
  maxAttempts: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  agnesBaseUrl: "https://apihub.agnes-ai.com/v1",
  defaultResponseFormat: "b64_json",
  defaultSize: "1K",
  imageParamMode: "auto",
  probeModel: "agnes-image-2.5-flash",
  probeConcurrency: 2,
  requestTimeoutMs: 300000,
  autoRefreshIntervalMs: 5000,
  maxAttempts: 3,
};

export interface SettingsStore {
  read(): Promise<AppSettings>;
  write(next: AppSettings): Promise<void>;
}

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, message, "invalid_request_error", field, "invalid_setting");
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("agnesBaseUrl", "agnesBaseUrl must be a valid URL");
  }
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw invalid(
      "agnesBaseUrl",
      "agnesBaseUrl must use https (http is only allowed for localhost)",
    );
  }
  return value.trim().replace(/\/+$/, "");
}

function integerInRange(field: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(field, `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Validates a full or partial settings object, filling missing fields with defaults. */
export function validateSettings(input: unknown): AppSettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApiError(
      400,
      "settings must be an object",
      "invalid_request_error",
      null,
      "invalid_setting",
    );
  }
  const source = input as Record<string, unknown>;
  const pick = <K extends keyof AppSettings>(key: K): unknown =>
    source[key] === undefined ? DEFAULT_SETTINGS[key] : source[key];

  const agnesBaseUrl = pick("agnesBaseUrl");
  if (typeof agnesBaseUrl !== "string" || agnesBaseUrl.trim() === "") {
    throw invalid("agnesBaseUrl", "agnesBaseUrl must be a non-empty string");
  }

  const defaultResponseFormat = pick("defaultResponseFormat");
  if (defaultResponseFormat !== "b64_json" && defaultResponseFormat !== "url") {
    throw invalid("defaultResponseFormat", "defaultResponseFormat must be b64_json or url");
  }

  const defaultSize = pick("defaultSize");
  if (!isSizeTier(defaultSize)) {
    throw invalid("defaultSize", "defaultSize must be one of 1K, 2K, 3K, 4K");
  }

  const imageParamMode = pick("imageParamMode");
  if (imageParamMode !== "auto" && imageParamMode !== "nested" && imageParamMode !== "top_level") {
    throw invalid("imageParamMode", "imageParamMode must be auto, nested or top_level");
  }

  const probeModel = pick("probeModel");
  if (typeof probeModel !== "string" || probeModel.trim() === "") {
    throw invalid("probeModel", "probeModel must be a non-empty string");
  }

  return {
    agnesBaseUrl: normalizeBaseUrl(agnesBaseUrl),
    defaultResponseFormat,
    defaultSize: defaultSize.toUpperCase() as SizeTier,
    imageParamMode,
    probeModel: probeModel.trim(),
    probeConcurrency: integerInRange("probeConcurrency", pick("probeConcurrency"), 1, 10),
    requestTimeoutMs: integerInRange("requestTimeoutMs", pick("requestTimeoutMs"), 60_000, 360_000),
    autoRefreshIntervalMs: integerInRange(
      "autoRefreshIntervalMs",
      pick("autoRefreshIntervalMs"),
      2_000,
      60_000,
    ),
    maxAttempts: integerInRange("maxAttempts", pick("maxAttempts"), 1, 10),
  };
}

export function createSettingsStore(sql: SqlExecutor): SettingsStore {
  return {
    async read() {
      const result = await sql.execute("SELECT key, value FROM settings");
      const stored: Record<string, unknown> = {};
      for (const row of result.rows) {
        const key = String(row.key);
        if (!KEYS.includes(key as keyof AppSettings)) continue;
        stored[key] = JSON.parse(String(row.value));
      }
      return validateSettings({ ...DEFAULT_SETTINGS, ...stored });
    },

    async write(next) {
      const settings = validateSettings(next);
      const updatedAt = new Date().toISOString();
      await executeBatch(
        sql,
        KEYS.map((key) => ({
          sql:
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          args: [key, JSON.stringify(settings[key]), updatedAt],
        })),
      );
    },
  };
}

/** Adds a short read-through cache; writes refresh it immediately. */
export function createCachedSettings(
  store: SettingsStore,
  ttlMs: number = SETTINGS_CACHE_TTL_MS,
  now: () => number = () => Date.now(),
): SettingsStore {
  let cached: AppSettings | null = null;
  let loadedAt = 0;

  return {
    async read() {
      const stamp = now();
      if (cached && stamp - loadedAt < ttlMs) return cached;
      cached = await store.read();
      loadedAt = stamp;
      return cached;
    },
    async write(next) {
      const validated = validateSettings(next);
      await store.write(validated);
      cached = validated;
      loadedAt = now();
    },
  };
}
