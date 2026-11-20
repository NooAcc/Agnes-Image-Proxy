import { encodeBase64 } from "@std/encoding/base64";
import { SESSION_TTL_MS } from "./limits.ts";

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

export interface SessionSigner {
  issue(now?: Date): Promise<string>;
  verify(token: string, now?: Date): Promise<boolean>;
}

/**
 * Stateless HMAC session tokens. The signing key is derived from the proxy
 * API key, so rotating the key invalidates every outstanding session.
 */
export function createSessionSigner(apiKey: string, ttlMs: number = SESSION_TTL_MS): SessionSigner {
  const keyPromise: Promise<CryptoKey> = crypto.subtle.importKey(
    "raw",
    encoder.encode(`agnes-session:${apiKey}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  const sign = async (payload: string): Promise<string> => {
    const key = await keyPromise;
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    return base64Url(new Uint8Array(signature));
  };

  return {
    async issue(now: Date = new Date()): Promise<string> {
      const payload = base64UrlEncodeText(
        JSON.stringify({ iat: now.getTime(), exp: now.getTime() + ttlMs }),
      );
      return `${payload}.${await sign(payload)}`;
    },

    async verify(token: string, now: Date = new Date()): Promise<boolean> {
      const [payload, signature] = token.split(".");
      if (!payload || !signature) return false;
      const expected = await sign(payload);
      if (!timingSafeEqual(signature, expected)) return false;
      try {
        const decoded = JSON.parse(
          new TextDecoder().decode(decodeBase64Url(payload)),
        ) as { exp?: unknown };
        return typeof decoded.exp === "number" && decoded.exp > now.getTime();
      } catch {
        return false;
      }
    },
  };
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
