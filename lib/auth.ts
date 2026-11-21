import { encodeBase64 } from "@std/encoding/base64";
import { SESSION_MAX_MS, SESSION_RENEW_BEFORE_MS, SESSION_TTL_MS } from "./limits.ts";
import type { SqlExecutor } from "./sql.ts";

const encoder = new TextEncoder();

/** Constant-time string comparison (no early exit on the first differing byte). */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function base64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlEncodeText(text: string): string {
  return base64Url(encoder.encode(text));
}

export interface AuthStateStore {
  getSessionEpoch(): Promise<number>;
  bumpSessionEpoch(): Promise<number>;
}

/** Reads and bumps the session epoch; reads are cached for ten seconds. */
export function createAuthStateStore(
  sql: SqlExecutor,
  options: { ttlMs?: number; now?: () => number } = {},
): AuthStateStore {
  const ttlMs = options.ttlMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  let cached: number | null = null;
  let loadedAt = 0;

  const read = async (): Promise<number> => {
    const result = await sql.execute(
      "SELECT value FROM auth_state WHERE key = 'session_epoch'",
    );
    const value = Number(result.rows[0]?.value);
    return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 1;
  };

  return {
    async getSessionEpoch() {
      const stamp = now();
      if (cached !== null && stamp - loadedAt < ttlMs) return cached;
      cached = await read();
      loadedAt = stamp;
      return cached;
    },

    async bumpSessionEpoch() {
      await sql.execute(
        `INSERT INTO auth_state (key, value, updated_at) VALUES ('session_epoch', '2', ?)
         ON CONFLICT (key) DO UPDATE SET
           value = CAST(value AS INTEGER) + 1,
           updated_at = excluded.updated_at`,
        [new Date().toISOString()],
      );
      cached = await read();
      loadedAt = now();
      return cached;
    },
  };
}

export interface SessionClaims {
  epoch: number;
  iat: number;
  exp: number;
}

export interface SessionService {
  issue(now?: Date): Promise<string>;
  verify(token: string, now?: Date): Promise<SessionClaims | null>;
  renew(token: string, now?: Date): Promise<string | null>;
  revokeAll(now?: Date): Promise<number>;
}

/**
 * Stateless HMAC session tokens bound to the stored session epoch. Bumping
 * the epoch invalidates every outstanding token. Tokens slide forward when
 * they have less than seven days left, capped at ninety days after issue.
 */
export function createSessionService(
  apiKey: string,
  authState: AuthStateStore,
  options: { ttlMs?: number; renewBeforeMs?: number; maxMs?: number } = {},
): SessionService {
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const renewBeforeMs = options.renewBeforeMs ?? SESSION_RENEW_BEFORE_MS;
  const maxMs = options.maxMs ?? SESSION_MAX_MS;
  const keys = new Map<number, Promise<CryptoKey>>();

  const keyFor = (epoch: number): Promise<CryptoKey> => {
    let key = keys.get(epoch);
    if (!key) {
      key = crypto.subtle.importKey(
        "raw",
        encoder.encode(`agnes-session:${apiKey}:${epoch}`),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
      keys.set(epoch, key);
    }
    return key;
  };

  const sign = async (payload: string, epoch: number): Promise<string> => {
    const signature = await crypto.subtle.sign(
      "HMAC",
      await keyFor(epoch),
      encoder.encode(payload),
    );
    return base64Url(new Uint8Array(signature));
  };

  const encode = async (claims: SessionClaims): Promise<string> => {
    const payload = base64UrlEncodeText(
      JSON.stringify({ v: claims.epoch, iat: claims.iat, exp: claims.exp }),
    );
    return `${payload}.${await sign(payload, claims.epoch)}`;
  };

  const decode = async (token: string): Promise<SessionClaims | null> => {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    let raw: { v?: unknown; iat?: unknown; exp?: unknown };
    try {
      raw = JSON.parse(decodeBase64UrlText(payload));
    } catch {
      return null;
    }
    const epoch = Number(raw.v);
    if (!Number.isInteger(epoch) || typeof raw.iat !== "number" || typeof raw.exp !== "number") {
      return null;
    }
    if (epoch !== await authState.getSessionEpoch()) return null;
    const expected = await sign(payload, epoch);
    if (!timingSafeEqual(signature, expected)) return null;
    return { epoch, iat: raw.iat, exp: raw.exp };
  };

  return {
    async issue(now: Date = new Date()): Promise<string> {
      const iat = now.getTime();
      const epoch = await authState.getSessionEpoch();
      return await encode({ epoch, iat, exp: Math.min(iat + ttlMs, iat + maxMs) });
    },

    async verify(token: string, now: Date = new Date()): Promise<SessionClaims | null> {
      const claims = await decode(token);
      if (!claims || claims.exp <= now.getTime()) return null;
      return claims;
    },

    async renew(token: string, now: Date = new Date()): Promise<string | null> {
      const claims = await decode(token);
      const stamp = now.getTime();
      if (!claims || claims.exp <= stamp) return null;
      if (claims.exp - stamp >= renewBeforeMs) return null;
      if (stamp >= claims.iat + maxMs) return null;
      return await encode({
        epoch: claims.epoch,
        iat: claims.iat,
        exp: Math.min(stamp + ttlMs, claims.iat + maxMs),
      });
    },

    async revokeAll(): Promise<number> {
      return await authState.bumpSessionEpoch();
    },
  };
}

function decodeBase64UrlText(value: string): string {
  return new TextDecoder().decode(decodeBase64Url(value));
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
