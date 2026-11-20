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

export interface GatewayHooks {
  onAccountUsed?(account: ClaimedAccount): void;
  onAttemptFailed?(account: ClaimedAccount, error: unknown): void;
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
          let failures = 0;
          let lastError: unknown = null;

          while (tried.length < maxAttempts) {
            const account = await options.store.claim(tried);
            if (!account) break;
            tried.push(account.id);

            try {
              const client = options.createClient({
                baseUrl,
                apiKey: account.apiKey,
                timeoutMs: gatewayOptions.timeoutMs,
              });
              const result = await client.generate(request, signal);
              await quietly(() => options.store.recordSuccess(account.id));
              hooks?.onAccountUsed?.(account);
              return { ...result, account: { id: account.id, name: account.name } };
            } catch (error) {
              const classification = classifyFailure(error);
              if (!classification.accountProblem) throw error;

              failures++;
              lastError = error;
              const cooldown = classification.exponential
                ? Math.min(
                  classification.cooldownMs * 2 ** account.consecutiveFailures,
                  ACCOUNT_COOLDOWN_MAX_MS,
                )
                : classification.cooldownMs;
              await quietly(() => options.store.recordFailure(account.id, cooldown));
              hooks?.onAttemptFailed?.(account, error);
            }
          }

          if (lastError !== null) {
            throw new ApiError(
              503,
              `all accounts failed after ${failures} attempt${failures === 1 ? "" : "s"}: ${
                errorMessage(lastError)
              }`,
              "server_error",
              null,
              "upstream_unavailable",
            );
          }
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
