import type { ClientSession, MongoClient } from "mongodb";
import { isMongoTransientError } from "./errors/index.ts";
import type { LoggerLike } from "./utils/logger.ts";
import { sleep } from "./utils/timeout.ts";

export { isMongoTransientError, TRANSIENT_MONGO_ERROR_CODES } from "./errors/index.ts";

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  logger?: LoggerLike;
}

/**
 * Retry `fn` while it throws a *transient* Mongo error (network / not-primary /
 * sharding), with exponential backoff `delayMs * 2^attempt`. Domain errors and
 * genuine data errors are never retried.
 */
export const withRetry = async <T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
  _ctx?: unknown,
): Promise<T> => {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const delayMs = options.delayMs ?? 150;
  const logger = options.logger;

  let attempt = 0;
  let lastError: unknown;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      attempt += 1;
      if (attempt >= maxAttempts || !isMongoTransientError(err)) throw err;
      const backoff = delayMs * 2 ** (attempt - 1);
      logger?.debug?.({ attempt, backoffMs: backoff, error: (err as Error)?.message }, "retrying");
      await sleep(backoff);
    }
  }
  // The loop above runs at least once and either returns or throws, so this is
  // unreachable in practice — but it guarantees `maxAttempts: 0` never turns
  // into `throw undefined`.
  throw lastError ?? new Error("withRetry: no attempt was made (maxAttempts must be >= 1)");
};

/**
 * Manual transaction helper: start → run → commit, aborting + ending the
 * session on any failure. Prefer the service-level `transaction()` which also
 * handles capability detection and unsupported-server fallback.
 */
export const withTransaction = async <T>(
  client: MongoClient,
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> => {
  const session = client.startSession();
  try {
    session.startTransaction();
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    throw err;
  } finally {
    // Never let a failing `endSession` mask the original error.
    await session.endSession().catch(() => {});
  }
};
