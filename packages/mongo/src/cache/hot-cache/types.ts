/**
 * Types + constants for the HotCache layer. All type-only (plus the stream-key
 * separator constant), so the coordinating class (`HotCache` in `./index.ts`)
 * and its strategy modules (`./ticker.ts`, `./watcher.ts`) share one vocabulary
 * without importing each other's runtime logic.
 */
import type { Db } from "mongodb";
import type { LoggerLike } from "../../utils/logger.ts";
import type { LRU } from "../../utils/lru.ts";

/** Separator used in stream/dedupe keys so names can't collide across parts. */
export const WATCH_SEP = "\u0000";

/** A collection to watch for invalidation. `collection` is the PHYSICAL name. */
export interface HotCollectionRef {
  /** Raw `Db` handle (e.g. `service.db.primaryClient.client`). */
  db: Db;
  /** Physical collection name whose writes invalidate bound queries. */
  collection: string;
}

/** Opt-in query registration. `TArgs` = the parameter tuple, `TResult` = loader result. */
export interface HotQueryConfig<TArgs extends readonly unknown[], TResult> {
  /** Read-through loader executed on cache miss / background refresh. */
  loader: (...args: TArgs) => Promise<TResult>;
  /**
   * Optional cache-key extractor. Lets callers decide which parameters form the
   * key (e.g. hash only some of them). Default: `stableHash` of all arguments.
   */
  keyOf?: (...args: TArgs) => string;
  /** Per-query TTL in ms (`0` = no expiry). Defaults to `defaultTtlMs`. */
  ttlMs?: number;
  /** Per-query LRU cap. Defaults to `defaultMaxSize`. */
  maxSize?: number;
  /**
   * Background refresh interval in ms (standalone ticker only). Default `0` =
   * no background refresh — entries then update only via `ttlMs` expiry or
   * manual `invalidate*` calls. In standalone mode with `autoRefresh` on, a
   * query with neither `refreshIntervalMs` nor `ttlMs` set serves values until
   * it is manually invalidated (unbounded staleness); `start()` logs a warning
   * naming those queries so you can opt in deliberately.
   */
  refreshIntervalMs?: number;
  /**
   * Collections whose data changes invalidate this query. Used by replica mode
   * to open change-stream watchers. In standalone mode these have no effect
   * (the ticker refreshes instead) — use `invalidateCollection` manually if
   * needed.
   */
  watch?: HotCollectionRef[];
  /**
   * Clone results on every read so callers can't mutate the shared cached entry
   * (default false — cloning has a per-read cost; treat cached results as
   * read-only when disabled).
   */
  clone?: boolean;
  /**
   * Upper bound (bytes) for a cached value, estimated via a cheap BSON-aware
   * size probe. Larger values are still returned to the caller but are NOT
   * cached (a first oversized result logs a warning). Protects the LRU from
   * holding unbounded single entries. Default: no limit.
   */
  maxValueBytes?: number;
}

export interface HotCacheOptions {
  /**
   * Replica-support probe. Default: `probeMongoCapabilities` over the first
   * watched collection's `db`. Return `true` → change-stream mode,
   * `false` → standalone ticker mode. A probe that returns no result (timeout)
   * falls back to standalone with a warning — pass `mode` to pin the behavior.
   */
  probe?: () => Promise<boolean>;
  /**
   * Pin the cache mode directly, skipping the probe entirely. `'replica'` opens
   * change-stream watchers, `'standalone'` starts the ticker. Useful when the
   * deployment is known (e.g. from connection config) and you want to avoid a
   * `hello` round-trip or a mis-detection.
   */
  mode?: "replica" | "standalone";
  /** Default per-query TTL in ms (`0` = no expiry). Default `0`. */
  defaultTtlMs?: number;
  /** Default per-query LRU cap. Default `500`. */
  defaultMaxSize?: number;
  /** Global ticker interval in ms (standalone mode). Default `1000`. */
  tickIntervalMs?: number;
  /**
   * Master switch for the standalone background-refresh ticker. `true` (default)
   * runs the global ticker that re-fetches entries at `refreshIntervalMs`. Set
   * `false` to turn off auto-refetch entirely — data then updates only via
   * manual `invalidate`/`invalidateParams`/`invalidateCollection` or `ttlMs`
   * expiry. Replica-mode change streams are event-driven and unaffected.
   */
  autoRefresh?: boolean;
  logger?: LoggerLike;
}

export type HotCacheMode = "unknown" | "replica" | "standalone";

/** Typed handle returned by `register` — type-safe alternative to dynamic `get`. */
export interface HotQueryAccessor<TArgs extends readonly unknown[], TResult> {
  /** Read-through: serve from LRU, else run the loader. */
  get: (...args: TArgs) => Promise<TResult>;
  /**
   * Manual invalidation (fully typed, with intellisense on the parameters).
   * Called with no arguments it drops every cached entry for this query; called
   * with the query's parameters it drops only that parameter's entry.
   *
   *   topProducts.invalidate();      // drop all
   *   topProducts.invalidate(10);    // drop only the { limit: 10 } entry
   */
  invalidate: {
    (): void;
    (...args: TArgs): void;
  };
}

/** One cached value + the bookkeeping that drives expiry / background refresh. */
export interface Entry {
  value: unknown;
  args: readonly unknown[];
  expiresAt: number;
  nextRefreshAt: number;
}

/** Runtime state for one registered query (owned by `HotCache`, mutated by ticker/watcher). */
export interface RegisteredQuery {
  name: string;
  config: HotQueryConfig<readonly unknown[], unknown>;
  lru: LRU<string, Entry>;
  ttlMs: number;
  refreshIntervalMs: number;
  clone: boolean;
  maxValueBytes?: number;
  /** Bumped on every invalidation/clear so in-flight loads don't re-store stale data. */
  gen: number;
  hits: number;
  misses: number;
  refreshes: number;
  loadErrors: number;
  sizeSkips: number;
  warnedSize: boolean;
}

/** Per-query runtime counters (see `HotCache.stats()`). */
export interface HotQueryStats {
  /** Current number of cached entries for this query. */
  size: number;
  /** Reads served from the LRU without running the loader. */
  hits: number;
  /** Reads that ran the loader (LRU miss or expired entry). */
  misses: number;
  /** Background refreshes kicked by the standalone ticker. */
  refreshes: number;
  /** Loader rejections (failed reads/refreshes). */
  loadErrors: number;
  /** Values too large to cache (`maxValueBytes`). */
  sizeSkips: number;
  /** Capacity evictions (LRU). */
  evictions: number;
}

/** Snapshot of the whole cache (see `HotCache.stats()`). */
export interface HotCacheStats {
  mode: HotCacheMode;
  /** Number of registered queries. */
  queries: number;
  /** Total cached entries across all queries. */
  entries: number;
  perQuery: Record<string, HotQueryStats>;
}
