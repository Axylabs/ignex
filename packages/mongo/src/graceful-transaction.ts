import type { ClientSession } from "mongodb";
import { type createMongoCapabilitiesStore, mongoTransactionsEnabled } from "./capabilities.ts";
import { mapMongoDriverError } from "./errors/index.ts";
import type { LoggerLike } from "./utils/logger.ts";

/** Minimal transaction runner surface (satisfied by the service `transaction`). */
export interface MongoTransactionRunner {
  transaction: <T>(fn: (session: ClientSession | null) => Promise<T>) => Promise<T>;
}

export interface GracefulTransactionOptions {
  capabilities?: ReturnType<typeof createMongoCapabilitiesStore>;
  urlHint?: string;
  logger?: LoggerLike;
  /** Map driver errors to typed DomainError/InfraError before rethrowing (default true). */
  wrapMongoErrors?: boolean;
}

/**
 * Run `fn` inside a transaction when the deployment supports it; otherwise run
 * with a `null` session (no-op fallback). Also handles the "retryable writes
 * unsupported" error by re-running with a null session.
 */
export const withGracefulMongoTransaction = async <T>(
  runner: MongoTransactionRunner,
  fn: (session: ClientSession | null) => Promise<T>,
  options: GracefulTransactionOptions = {},
): Promise<T> => {
  const enabled =
    options.capabilities === undefined ||
    mongoTransactionsEnabled(options.capabilities, {
      ...(options.urlHint !== undefined ? { urlHint: options.urlHint } : {}),
    });
  if (!enabled) return fn(null);

  try {
    return await runner.transaction(fn);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/Transaction numbers are only allowed|transactions are not supported/i.test(message)) {
      options.logger?.warn?.({ error: message }, "transactions unsupported, falling back");
      return fn(null);
    }
    if (options.wrapMongoErrors !== false) {
      throw mapMongoDriverError(err, { op: "transaction" });
    }
    throw err;
  }
};
