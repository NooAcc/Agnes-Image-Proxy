/** Shared numeric limits. Keep in sync with the design document. */

export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_INPUT_IMAGES = 16;

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const ARCHIVE_TIMEOUT_MS = 60_000;

export const REMOTE_IMAGE_TIMEOUT_MS = 10_000;
export const REMOTE_IMAGE_MAX_BYTES = 1024 * 1024;
export const REMOTE_IMAGE_MAX_REDIRECTS = 2;

export const UPSTREAM_TIMEOUT_MS = 300_000;
export const MIN_UPSTREAM_TIMEOUT_MS = 60_000;
export const MAX_UPSTREAM_TIMEOUT_MS = 360_000;
export const MAX_UPSTREAM_ATTEMPTS = 3;

export const REQUEST_LOG_LIMIT = 500;
export const LOG_LIST_LIMIT = 200;
/** Days of daily totals shown in the console overview chart. */
export const OVERVIEW_TREND_DAYS = 14;

export const GALLERY_PAGE_SIZE = 24;
export const GALLERY_PAGE_MAX = 100;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SETTINGS_CACHE_TTL_MS = 10_000;
export const IMAGE_PARAM_MODE_TTL_MS = 10 * 60 * 1000;

export const ACCOUNT_COOLDOWN_AUTH_MS = 15 * 60 * 1000;
export const ACCOUNT_COOLDOWN_RATE_LIMIT_MS = 60 * 1000;
export const ACCOUNT_COOLDOWN_MAX_MS = 15 * 60 * 1000;

// `n` is only required to be a positive safe integer; there is no 1–10 cap.
export function isValidImageCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
