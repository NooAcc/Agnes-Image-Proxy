export type EnvGetter = (key: string) => string | undefined;

export interface Config {
  apiKey: string;
  tursoDatabaseUrl: string;
  tursoAuthToken: string;
  port: number;
  corsAllowedOrigins: string[];
}

function requireEnv(getEnv: EnvGetter, key: string): string {
  const value = getEnv(key);
  if (value === undefined || value.trim() === "") {
    throw new Error(`missing required environment variable: ${key}`);
  }
  return value.trim();
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 8000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid PORT: ${raw}`);
  }
  return port;
}

function parseOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid CORS origin: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`invalid CORS origin (must be http or https): ${raw}`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "") {
    throw new Error(`invalid CORS origin (must be scheme://host[:port]): ${raw}`);
  }
  return `${url.protocol}//${url.host}`;
}

function parseCorsOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map(parseOrigin);
}

export function loadConfig(getEnv: EnvGetter): Config {
  return {
    apiKey: requireEnv(getEnv, "PROXY_API_KEY"),
    tursoDatabaseUrl: requireEnv(getEnv, "TURSO_DATABASE_URL"),
    tursoAuthToken: requireEnv(getEnv, "TURSO_AUTH_TOKEN"),
    port: parsePort(getEnv("PORT")),
    corsAllowedOrigins: parseCorsOrigins(getEnv("CORS_ALLOWED_ORIGINS")),
  };
}
