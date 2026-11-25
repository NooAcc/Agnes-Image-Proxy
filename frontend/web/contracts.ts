/**
 * Pure browser contracts shared by the console scripts, the login page and
 * native tests. Keep every function self-contained, plain JavaScript and free
 * of TypeScript-only syntax: the build embeds `Function.prototype.toString()`
 * output into the generated assets, so the same tested source runs in browsers.
 */

/** Fields accepted by PUT /admin/api/settings, in payload order. */
export const SETTINGS_FIELDS = [
  "agnesBaseUrl",
  "defaultSize",
  "imageParamMode",
  "probeModel",
  "probeConcurrency",
  "requestTimeoutMs",
  "autoRefreshIntervalMs",
  "maxAttempts",
  "imageServiceBaseUrl",
  "thumbnailWidth",
  "thumbnailQuality",
  "enrichTimeoutMs",
  "imageUrlTtlHours",
  "imagePublicBaseUrl",
];


/**
 * Parse the legacy `name,key` import text.
 * @param {string} text
 * @returns {{accounts: Array<{name: string, apiKey: string}>, lineNumbers: number[], errors: Array<{line: number, message: string}>}}
 */
export function parseAccountImport(text) {
  const accounts = [];
  const lineNumbers = [];
  const errors = [];
  const lines = String(text === undefined || text === null ? "" : text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    const line = index + 1;
    const comma = raw.indexOf(",");
    if (comma === -1) {
      errors.push({ line: line, message: "第 " + line + " 行缺少逗号，格式应为「名称,密钥」" });
      continue;
    }
    const name = raw.slice(0, comma).trim();
    const apiKey = raw.slice(comma + 1).trim();
    if (!name || !apiKey) {
      errors.push({ line: line, message: "第 " + line + " 行的名称或密钥为空" });
      continue;
    }
    accounts.push({ name: name, apiKey: apiKey });
    lineNumbers.push(line);
  }
  if (accounts.length > 1000) {
    errors.push({ line: 0, message: "单次最多导入 1000 个账号" });
  }
  const payload = JSON.stringify({ accounts: accounts });
  const bytes = typeof TextEncoder === "function"
    ? new TextEncoder().encode(payload).length
    : payload.length;
  if (bytes > 1024 * 1024) {
    errors.push({ line: 0, message: "导入请求超过 1 MiB，请拆分后重试" });
  }
  return { accounts: accounts, lineNumbers: lineNumbers, errors: errors };
}

/**
 * Selected-day and 14-day ranges in backend UTC day arithmetic.
 * @param {string} day
 * @returns {{selected: {start: string, end: string}, trend: {start: string, end: string}} | null}
 */
export function overviewRanges(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parts = day.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const date = Number(parts[2]);
  const value = Date.UTC(year, month - 1, date);
  const parsed = new Date(value);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== date
  ) {
    return null;
  }
  const trendStart = new Date(value - 13 * 86400000).toISOString().slice(0, 10);
  return {
    selected: { start: day, end: day },
    trend: { start: trendStart, end: day },
  };
}


/**
 * Restrict post-login destinations to same-origin console paths/hashes.
 * @param {string} raw
 * @returns {string}
 */
export function safeAdminDestination(raw) {
  const sections = {
    overview: true,
    gallery: true,
    accounts: true,
    logs: true,
    settings: true,
  };
  const fallback = "/admin#overview";
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return fallback;
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value)) return fallback;
  if (value.charAt(0) === "#") {
    const hashOnly = value.slice(1);
    return sections[hashOnly] ? "/admin#" + hashOnly : fallback;
  }
  if (value.charAt(0) !== "/") return fallback;
  const hashAt = value.indexOf("#");
  const pathPart = hashAt === -1 ? value : value.slice(0, hashAt);
  const hashPart = hashAt === -1 ? "" : value.slice(hashAt + 1);
  let pathSection = null;
  if (pathPart === "/admin" || pathPart === "/admin/") {
    pathSection = null;
  } else {
    const match = /^\/admin\/([a-z]+)\/?$/.exec(pathPart);
    if (!match || !sections[match[1]]) return fallback;
    pathSection = match[1];
  }
  const hashSection = sections[hashPart] ? hashPart : null;
  return "/admin#" + (hashSection || pathSection || "overview");
}

/**
 * Build the complete settings PUT payload from form values.
 * @param {Record<string, unknown>} values
 * @returns {Record<string, unknown>}
 */
export function settingsPayload(values) {
  const fields = [
    "agnesBaseUrl",
    "defaultSize",
    "imageParamMode",
    "probeModel",
    "probeConcurrency",
    "requestTimeoutMs",
    "autoRefreshIntervalMs",
    "maxAttempts",
    "imageServiceBaseUrl",
    "thumbnailWidth",
    "thumbnailQuality",
    "enrichTimeoutMs",
    "imageUrlTtlHours",
    "imagePublicBaseUrl",
  ];
  const stringFields = {
    agnesBaseUrl: true,
    defaultSize: true,
    imageParamMode: true,
    probeModel: true,
    imageServiceBaseUrl: true,
    imagePublicBaseUrl: true,
  };
  const source = values || {};
  const payload = {};
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const value = source[field];
    if (stringFields[field]) {
      payload[field] = value === undefined || value === null ? "" : String(value);
    } else {
      payload[field] = Number(value);
    }
  }
  const ttl = payload.imageUrlTtlHours;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 720) {
    throw new RangeError("imageUrlTtlHours 必须是 1–720 的整数");
  }
  return payload;
}

/**
 * Merge newest-first pages by id, dropping duplicates and keeping order.
 * @param {Array<{id: unknown}>} existing
 * @param {Array<{id: unknown}>} incoming
 * @returns {Array<{id: unknown}>}
 */
export function mergeById(existing, incoming) {
  const seen = {};
  const merged = [];
  const add = function (items) {
    if (!items) return;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const key = String(item.id);
      if (seen[key]) continue;
      seen[key] = true;
      merged.push(item);
    }
  };
  add(incoming);
  add(existing);
  return merged;
}

/**
 * Render one cumulative backfill snapshot (never summed across polls).
 * @param {{processed?: number, succeeded?: number, failed?: number, running?: boolean, error?: string|null}} status
 * @returns {string}
 */
export function enrichSummaryText(status) {
  const value = status || {};
  const processed = Number(value.processed) || 0;
  const succeeded = Number(value.succeeded) || 0;
  const failed = Number(value.failed) || 0;
  let text = value.running ? "补齐处理中… " : "补齐已结束 ";
  text += "已处理 " + processed + " · 成功 " + succeeded + " · 失败 " + failed;
  if (value.error) text += " · 错误：" + value.error;
  return text;
}
