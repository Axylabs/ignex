/**
 * Service configuration: the `MongoServiceConfig` options type, cache policy
 * resolution (`resolveCache`), and runtime-config derivation
 * (`resolveRuntimeConfig`). Pure — no connection or manager wiring here, so the
 * config concerns of the service are isolated from the composition root.
 */
import { QueryCache, type QueryCacheOptions } from "../cache/query-cache.ts";
import type { DriftMode } from "../schema/validate-doc/index.ts";
import { createConsoleLogger, type LoggerLike } from "../utils/logger.ts";

/**
 * Performance is ON by default. Resolve the service-level cache:
 * `undefined` → a default `QueryCache()`; `QueryCacheOptions` → constructed;
 * `QueryCache` → reused; `null` → disabled.
 */
export const resolveCache = (
  value: QueryCache | QueryCacheOptions | null | undefined,
): QueryCache | undefined => {
  if (value === null) return undefined;
  if (value === undefined) return new QueryCache();
  if (value instanceof QueryCache) return value;
  return new QueryCache(value);
};

export interface MongoServiceConfig {
  defaultDb?: string;
  migrationDir?: string;
  appName?: string;
  logger?: LoggerLike;
  /**
   * Map driver errors to typed DomainError/InfraError before rethrowing. ON by
   * default — set `false` to surface raw driver errors instead.
   */
  wrapMongoErrors?: boolean;
  /**
   * Read-through query cache shared by every CRUD read. ON by default:
   * `undefined` creates a default `QueryCache()`, `QueryCacheOptions` builds
   * one, a `QueryCache` is reused, and `null` disables caching.
   *
   * INVALIDATION: entries are dropped write-through — every ORM write
   * invalidates that collection's cached reads. External writers (other
   * processes, the raw `client` escape hatch, direct DB writes) do NOT
   * invalidate; with the default `ttlMs: 0` those reads stay stale
   * indefinitely, so multi-writer deployments should set `QueryCacheOptions.ttlMs`,
   * disable the cache, route latency-critical reads through the
   * change-stream aware `createHotCache()`, or set `cacheWatch: true`.
   */
  cache?: QueryCache | QueryCacheOptions | null;
  /**
   * Opt into change-stream invalidation of the shared query cache. When `true`
   * (and a cache is enabled), after `makeConnections()` one `$changeStream`
   * watcher is opened per registered collection; any write — including external
   * ones — invalidates that collection's cached reads. Requires a replica set /
   * mongos. On standalone servers the streams are rejected, a warning is logged
   * once, and invalidation silently disables (the cache stays write-through
   * only). Watchers self-heal across transient errors and are closed by
   * `closeConnections()`. Default: false.
   */
  cacheWatch?: boolean;
  /** Coalesce identical concurrent reads into one driver call. ON by default. */
  dedupeReads?: boolean;
  /**
   * Master performance switch. `perf: false` disables the query cache and
   * in-flight dedup even when the granular options are set. Defaults to true.
   */
  perf?: boolean;
  /**
   * Schema-drift policy for reads. When a document fetched from the DB
   * (cache-miss) doesn't match its declared schema:
   *   - `'report'` (default) — log a warning with the offending fields, return as-is
   *   - `'throw'` — throw `DomainError SCHEMA_DRIFT` (the document is never
   *     cached or returned)
   *   - `'off'` — no drift checking (previous behavior)
   * Detection-only: documents are never mutated. Projected/partial reads are
   * skipped. Overridable per op via `QueryOptions.drift`.
   */
  drift?: DriftMode;
}

/** The resolved, environment-merged runtime config shared by the whole service. */
export interface ResolvedServiceConfig {
  config: { defaultDb: string; migrationDir: string; appName: string };
  logger: LoggerLike;
  perfEnabled: boolean;
  sharedCache: QueryCache | undefined;
  dedupeReads: boolean;
  wrapMongoErrors: boolean;
}

/**
 * Merge `MongoServiceConfig` overrides with environment defaults and derive the
 * performance flags (cache/dedup/wrapMongoErrors). Called once by
 * `createMongoService`.
 */
export const resolveRuntimeConfig = (
  configOverrides: MongoServiceConfig,
): ResolvedServiceConfig => {
  const config = {
    defaultDb: configOverrides.defaultDb ?? process.env.MONGO_URL ?? "mongodb://localhost:27017/",
    migrationDir: configOverrides.migrationDir ?? process.env.MIGRATION_DIR ?? "./migrations",
    appName: configOverrides.appName ?? process.env.APP_NAME ?? "unknown-app",
  };
  const logger = configOverrides.logger ?? createConsoleLogger();
  // Perf is ON by default; `perf: false` (or the granular opt-outs) disable it.
  const perfEnabled = configOverrides.perf !== false;
  const sharedCache = perfEnabled ? resolveCache(configOverrides.cache) : undefined;
  const dedupeReads = perfEnabled ? (configOverrides.dedupeReads ?? true) : false;
  // Driver errors are mapped to typed DomainError/InfraError by default so a
  // framework can forward them to the client; `wrapMongoErrors: false` opts out.
  const wrapMongoErrors = configOverrides.wrapMongoErrors !== false;
  return { config, logger, perfEnabled, sharedCache, dedupeReads, wrapMongoErrors };
};
