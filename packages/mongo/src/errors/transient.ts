/**
 * Transient-error detection: which MongoDB errors are safe to retry. This is a
 * leaf module (no folder imports) so both `driver-map.ts` and `http-status.ts`
 * can depend on it without cycles.
 */

/**
 * Server error codes MongoDB raises that are safe to retry (network hiccups,
 * not-primary, sharding moves, interrupted queries). Mirrors the reference set.
 *
 * Frozen + typed `ReadonlySet` so a consumer can't mutate the shared instance
 * (it is a module-level singleton, re-exported through the barrel).
 */
export const TRANSIENT_MONGO_ERROR_CODES: ReadonlySet<number> = Object.freeze(
  new Set<number>([
    6, // HostUnreachable
    7, // HostNotFound
    89, // NetworkTimeout
    91, // ShutdownInProgress
    189, // PrimarySteppedDown
    9001, // SocketException
    10107, // NotWritablePrimary
    11600, // InterruptedAtShutdown
    11602, // InterruptedDueToReplStateChange
    13435, // NotPrimaryNoSecondaryOk
    13436, // NotPrimaryOrSecondary
  ]),
);

const TRANSIENT_NAME =
  /MongoNetworkError|PoolClearedError|MongoWriteConcernError|MongoNotPrimaryError|MongoNodeIsRecoveringError|MongoNetworkTimeoutError/;

/** True when the error is a transient Mongo failure that retry can recover from. */
export const isMongoTransientError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; code?: unknown; errInfo?: unknown };
  if (typeof e.name === "string" && TRANSIENT_NAME.test(e.name)) return true;
  if (typeof e.code === "number" && TRANSIENT_MONGO_ERROR_CODES.has(e.code)) return true;
  return false;
};

/** True when the error is a duplicate-key violation (code 11000 / E11000 message). */
export const isMongoDuplicateKeyError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === 11000) return true;
  if (typeof e.message === "string" && /E11000|duplicate key/i.test(e.message)) return true;
  return false;
};
