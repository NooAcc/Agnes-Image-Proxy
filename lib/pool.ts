import { ApiError } from "./errors.ts";
import {
  ACCOUNT_COOLDOWN_AUTH_MS,
  ACCOUNT_COOLDOWN_MAX_MS,
  ACCOUNT_COOLDOWN_RATE_LIMIT_MS,
  MAX_UPSTREAM_ATTEMPTS,
} from "./limits.ts";
import type { AccountStore, ClaimedAccount } from "./accounts.ts";

export interface AgnesRequest {
  path: string;
  body: unknown;
}

export interface AgnesResult {
  status: number;
  body: unknown;
}

export interface AgnesClient {
  generate(request: AgnesRequest, signal?: AbortSignal): Promise<AgnesResult>;
}

export type AgnesClientFactory = (credentials: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}) => AgnesClient;

export interface ServedBy {
  id: number;
  name: string;
}

export interface GatewayOptions {
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface AttemptMeta {
  durationMs: number;
}

export interface GatewayHooks {
  onAccountUsed?(account: ClaimedAccount, meta: AttemptMeta): void;
  onAttemptFailed?(account: ClaimedAccount, error: unknown, meta: AttemptMeta): void;
}

export interface GatewayResult extends AgnesResult {
  account: ServedBy;
}

export interface AgnesGateway {
  generate(request: AgnesRequest, signal?: AbortSignal): Promise<GatewayResult>;
}

export interface AccountPool {
  gateway(baseUrl: string, hooks?: GatewayHooks, options?: GatewayOptions): AgnesGateway;
}

export interface FailureClassification {
  cooldownMs: number;
  /** False for client errors where switching keys cannot help (400/404). */
  accountProblem: boolean;
  /** True when the cooldown should grow exponentially with consecutive failures. */
  exponential: boolean;
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

export function classifyFailure(error: unknown): FailureClassification {
  if (error instanceof ApiError) {
    if (error.status === 400 || error.status === 404) {
      return { cooldownMs: 0, accountProblem: false, exponential: false };
    }
    if (error.status === 401 || error.status === 403) {
      return { cooldownMs: ACCOUNT_COOLDOWN_AUTH_MS, accountProblem: true, exponential: false };
    }
    if (error.status === 429) {
      return {
        cooldownMs: retryAfterMs(error.headers) ?? ACCOUNT_COOLDOWN_RATE_LIMIT_MS,
        accountProblem: true,
        exponential: false,
      };
    }
  }
  return {
    cooldownMs: ACCOUNT_COOLDOWN_RATE_LIMIT_MS,
    accountProblem: true,
    exponential: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Account cooldown after a failure, capped at fifteen minutes. */
export function cappedCooldownMs(error: unknown): number {
  const classification = classifyFailure(error);
  if (!classification.accountProblem) return 0;
  const base = classification.exponential
    ? Math.max(classification.cooldownMs, ACCOUNT_COOLDOWN_RATE_LIMIT_MS)
    : classification.cooldownMs;
  return Math.min(base, ACCOUNT_COOLDOWN_MAX_MS);
}

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(
    502,
    errorMessage(error),
    "server_error",
    null,
    "upstream_unavailable",
  );
}

/**
 * Chooses the error returned after every attempt failed.
 * Priority: 429 > 504 > 502 > 503. Client errors (400/404) propagate as-is.
 */
export function selectFailure(
  errors: unknown[],
  attempts: number,
  options: { prefix?: boolean } = {},
): ApiError {
  const apiErrors = errors.map(asApiError);
  const prefix = options.prefix ?? true;
  const messageOf = (error: ApiError): string =>
    prefix
      ? `all accounts failed after ${attempts} attempt${
        attempts === 1 ? "" : "s"
      }: ${error.message}`
      : error.message;

  const clientError = apiErrors.find((error) => error.status === 400 || error.status === 404);
  if (clientError) {
    if (!prefix) return clientError;
    return new ApiError(
      clientError.status,
      messageOf(clientError),
      clientError.type,
      clientError.param,
      clientError.code,
      clientError.headers,
    );
  }

  const rateLimited = apiErrors.filter((error) => error.status === 429);
  if (rateLimited.length > 0) {
    let best = rateLimited[0];
    let bestCooldown = cappedCooldownMs(best);
    for (const error of rateLimited.slice(1)) {
      const cooldown = cappedCooldownMs(error);
      if (cooldown < bestCooldown) {
        best = error;
        bestCooldown = cooldown;
      }
    }
    const headers = new Headers(best.headers);
    headers.set("retry-after", String(Math.ceil(bestCooldown / 1000)));
    return new ApiError(
      429,
      messageOf(best),
      "rate_limit_error",
      null,
      "rate_limit_exceeded",
      headers,
    );
  }

  const make = (selected: ApiError, code: string): ApiError =>
    new ApiError(selected.status, messageOf(selected), "server_error", null, code);

  const timeout = apiErrors.find((error) => error.status === 504);
  if (timeout) return make(timeout, "upstream_timeout");

  const unavailable = apiErrors.find((error) => error.status === 502);
  if (unavailable) {
    return make(
      unavailable,
      unavailable.code === "invalid_upstream_response"
        ? "invalid_upstream_response"
        : "upstream_unavailable",
    );
  }

  const noAccounts = apiErrors.find(
    (error) => error.status === 503 && error.code === "no_available_accounts",
  );
  const selected = noAccounts ?? apiErrors.find((error) => error.status === 503) ?? apiErrors[0];
  if (!selected) {
    return new ApiError(
      503,
      "no available accounts (all keys are disabled or cooling down)",
      "server_error",
      null,
      "no_available_accounts",
    );
  }
  return new ApiError(
    503,
    messageOf(selected),
    "server_error",
    null,
    selected.code === "no_available_accounts" ? "no_available_accounts" : "upstream_unavailable",
  );
}

async function quietly(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error("account bookkeeping failed:", error);
  }
}

export function createAccountPool(
  options: { store: AccountStore; createClient: AgnesClientFactory },
): AccountPool {
  return {
    gateway(baseUrl, hooks, gatewayOptions = {}) {
      const maxAttempts = Math.max(1, gatewayOptions.maxAttempts ?? MAX_UPSTREAM_ATTEMPTS);

      return {
        async generate(request, signal) {
          const tried: number[] = [];
          const failures: unknown[] = [];

          while (tried.length < maxAttempts) {
            const account = await options.store.claim(tried);
            if (!account) break;
            tried.push(account.id);

            const startedAt = Date.now();
            try {
              const client = options.createClient({
                baseUrl,
                apiKey: account.apiKey,
                timeoutMs: gatewayOptions.timeoutMs,
              });
              const result = await client.generate(request, signal);
              await quietly(() =>
                options.store.recordSuccess(account.id, account.consecutiveFailures)
              );
              hooks?.onAccountUsed?.(account, { durationMs: Date.now() - startedAt });
              return { ...result, account: { id: account.id, name: account.name } };
            } catch (error) {
              const durationMs = Date.now() - startedAt;
              hooks?.onAttemptFailed?.(account, error, { durationMs });
              const classification = classifyFailure(error);
              if (!classification.accountProblem) throw error;

              failures.push(error);
              const cooldown = classification.exponential
                ? Math.min(
                  classification.cooldownMs * 2 ** account.consecutiveFailures,
                  ACCOUNT_COOLDOWN_MAX_MS,
                )
                : cappedCooldownMs(error);
              await quietly(() => options.store.recordFailure(account.id, cooldown));
            }
          }

          if (failures.length > 0) throw selectFailure(failures, failures.length);
          throw new ApiError(
            503,
            "no available accounts (all keys are disabled or cooling down)",
            "server_error",
            null,
            "no_available_accounts",
          );
        },
      };
    },
  };
}
