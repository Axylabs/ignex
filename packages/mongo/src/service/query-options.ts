import type {
  ClientSession,
  CollationOptions,
  Document,
  Hint,
  ReadConcern,
  ReadPreferenceLike,
  WriteConcern,
} from "mongodb";
import type { DriftMode } from "../schema/validate-doc/index.ts";

/**
 * SDK-level query options. These are separated from driver options so the
 * public API surface stays stable against driver changes. `resolveQueryOptions`
 * strips them out and forwards the remainder untouched to the driver.
 */
export interface QueryOptions {
  session?: ClientSession;
  maxTimeMS?: number;
  hint?: Hint;
  /** Retry attempts for transient errors (default 3). */
  maxAttempts?: number;
  /** Base retry backoff in ms (default 150, exponential). */
  retryDelayMs?: number;
  batchSize?: number;
  /**
   * Per-op in-flight dedup override. `true` forces dedup on, `false` forces it
   * off (even when the service default is on); unset inherits the service
   * `dedupeReads` default.
   */
  dedupe?: boolean;
  /** Per-op read-cache bypass. `false` skips the cache for this read. */
  cache?: boolean;
  /**
   * Per-op write-retry override. Reads always retry transient errors; writes
   * retry ONLY when `retryWrites: true` (retrying a write is at-least-once —
   * a committed write whose ack was lost would be re-executed, so enable only
   * for idempotent writes). Default: off for write ops.
   */
  retryWrites?: boolean /**
   * Per-op schema-drift policy override for reads (see `MongoServiceConfig.drift`).
   * `true` → `'throw'`, `false` → `'off'`, or an explicit `DriftMode` string.
   * Unset inherits the service-level default (`'report'`). Only checked when a
   * document is fetched from the DB (cache-miss); projected/partial reads are
   * skipped.
   */;
  drift?:
    | DriftMode
    | boolean /** Driver-level options forwarded untouched to the underlying call. */;
  collation?: CollationOptions;
  readPreference?: ReadPreferenceLike;
  readConcern?: ReadConcern;
  writeConcern?: WriteConcern;
  comment?: string | Document;
  let?: Document;
  timeoutMS?: number;
}

export interface ResolvedQueryOptions<TDriverOpts = Record<string, unknown>> {
  maxAttempts: number;
  retryDelayMs: number;
  /** Tri-state: `undefined` inherits the service-level default. */
  dedupe?: boolean;
  /** Tri-state: `undefined` inherits the service-level default. */
  cache?: boolean;
  /** Write ops retry transient errors only when this is `true`. */
  retryWrites?: boolean;
  sdk: {
    session?: ClientSession;
    maxTimeMS?: number;
    hint?: Hint;
    batchSize?: number;
    drift?: DriftMode | boolean;
  };
  driverOpts: TDriverOpts;
}

export const resolveQueryOptions = <T extends QueryOptions>(
  options?: T,
): ResolvedQueryOptions<Omit<T, keyof QueryOptions>> => {
  // Clamp to >= 1 so `maxAttempts: 0` (a common "disable retry" attempt) can
  // never reach `withRetry` and produce a `throw undefined`.
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
  const retryDelayMs = options?.retryDelayMs ?? 150;
  const {
    session,
    maxTimeMS,
    hint,
    batchSize,
    drift,
    maxAttempts: _ma,
    retryDelayMs: _rd,
    dedupe,
    cache,
    retryWrites,
    ...rest
  } = options ?? {};
  return {
    maxAttempts,
    retryDelayMs,
    ...(dedupe !== undefined ? { dedupe } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(retryWrites !== undefined ? { retryWrites } : {}),
    sdk: {
      ...(session !== undefined ? { session } : {}),
      ...(maxTimeMS !== undefined ? { maxTimeMS } : {}),
      ...(hint !== undefined ? { hint } : {}),
      ...(batchSize !== undefined ? { batchSize } : {}),
      ...(drift !== undefined ? { drift } : {}),
    },
    driverOpts: rest as Omit<T, keyof QueryOptions>,
  };
};

/** Build driver option objects omitting undefined SDK fields (exactOptionalPropertyTypes). */
export const pickSdkOptions = (sdk: {
  session?: unknown;
  maxTimeMS?: unknown;
  hint?: unknown;
  batchSize?: unknown;
  drift?: unknown;
}): Record<string, unknown> => ({
  ...(sdk.session !== undefined ? { session: sdk.session } : {}),
  ...(sdk.maxTimeMS !== undefined ? { maxTimeMS: sdk.maxTimeMS } : {}),
  ...(sdk.hint !== undefined ? { hint: sdk.hint } : {}),
  ...(sdk.batchSize !== undefined ? { batchSize: sdk.batchSize } : {}),
  ...(sdk.drift !== undefined ? { drift: sdk.drift } : {}),
});

/**
 * Resolve the effective drift mode for a read: per-op override wins, then the
 * service default, else `'report'`.
 */
export const resolveDriftMode = (
  perOp: DriftMode | boolean | undefined,
  serviceDefault: DriftMode | undefined,
): DriftMode => {
  if (perOp === true) return "throw";
  if (perOp === false) return "off";
  if (perOp === "off" || perOp === "report" || perOp === "throw") return perOp;
  return serviceDefault ?? "report";
};
