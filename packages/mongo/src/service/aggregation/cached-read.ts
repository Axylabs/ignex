/**
 * Cached-aggregation read pipeline — the aggregation analog of the CRUD read
 * path (`crud/context.ts` `read()`): write-through `QueryCache` + in-flight
 * dedup for MATERIALIZED aggregation results.
 *
 * Aggregation results are derived documents, so schema-drift checking is NOT
 * applied here (drift is for raw reads). Caching is skipped when:
 *   - the service has no cache (`perf:false` / `cache:null`) or the per-op
 *     `cache:false` bypass is set;
 *   - a session is present (transactional reads must hit the DB);
 *   - the pipeline is not cacheable — `$out`/`$merge` writes or `$sample`
 *     non-determinism (see `isCacheablePipeline`).
 *
 * Keys are db-namespaced by the PRIMARY collection; entries are additionally
 * registered under EVERY source collection (see `collectAggSources`) so a write
 * to ANY source invalidates them — this is what keeps `$lookup`/`$unionWith`
 * joins correct under write-through invalidation and `cacheWatch`.
 *
 * `aggregate()` (live cursor) and `pipeline().cursor()` are NOT cached — they
 * stream; use `pipeline().toArray()` / `.first()` for cached materialization.
 */
import type { AggregateOptions, Db, Document } from "mongodb";
import type { InFlight } from "../../cache/in-flight.ts";
import { cacheCollectionKey, type QueryCache } from "../../cache/query-cache.ts";
import { stableHash } from "../../utils/hash.ts";
import { defineCrudOp } from "../crud-op.ts";
import type { OpDeps } from "../op-deps.ts";
import {
  type QueryOptions,
  type ResolvedQueryOptions,
  resolveQueryOptions,
} from "../query-options.ts";
import { collectAggSources, isCacheablePipeline } from "./helpers.ts";

/**
 * The context the cached runner needs. Both the aggregation ops and the
 * `$facet` pagination strategy satisfy it structurally (their `opts` expose the
 * shared `cache` / `dedupeReads` / `inFlight` knobs).
 */
export type CachedAggregateCtx<C extends string> = {
  client: Db;
  deps: OpDeps<C>;
  opts: { cache?: QueryCache; dedupeReads: boolean; inFlight?: InFlight };
  resolve: (logical: string) => string;
};

/** Build the cached-aggregation runner from a collection-set-generic context. */
export const createCachedAggregate = <C extends string>(ctx: CachedAggregateCtx<C>) => {
  const { client, deps, opts, resolve } = ctx;
  const cache = opts.cache;

  return async <X extends string, T>(input: {
    collection: X;
    opName: string;
    pipeline: Document[];
    options?: AggregateOptions & QueryOptions;
    /** Additional LOGICAL source collections (e.g. `lookupJoin` fromCollections). */
    sources?: string[];
    execute: (resolved: ResolvedQueryOptions) => Promise<T>;
  }): Promise<T> => {
    const { collection: collectionName, opName, pipeline, options, sources = [], execute } = input;
    // `collectionName` is a known logical collection at the call site; the
    // widened `X extends string` keeps this assignable to `CachedAggregate`.
    const collection = collectionName as unknown as C;
    const physical = resolve(String(collection));
    const resolved = resolveQueryOptions(options);
    const noSession = !resolved.sdk.session;
    const useCache =
      cache !== undefined && noSession && resolved.cache !== false && isCacheablePipeline(pipeline);
    const shouldDedupe =
      resolved.dedupe !== false &&
      (resolved.dedupe === true || (opts.dedupeReads === true && noSession)) &&
      opts.inFlight !== undefined;

    // Keep the trace + transient-retry wrapper identical to today's path.
    const runDriver = (): Promise<T> => defineCrudOp(deps, collection, opName, execute, options);

    // Only hash when caching (noSession is guaranteed) — a live session would
    // not serialize cleanly.
    const key = useCache
      ? cache!.key(
          cacheCollectionKey(client.databaseName, physical),
          stableHash([opName, pipeline, options]),
        )
      : undefined;

    // Resolve every source collection → db-namespaced physical key, lazily (only
    // on a cache miss, so disabled caches pay nothing). Known logical names
    // resolve via `resolve()`; already-physical names (raw stages, `lookupJoin`)
    // pass through (a `resolve()` call on them would throw "Unknown collection").
    const toSourceKeys = () =>
      collectAggSources(String(collection), pipeline, sources).map((name) => {
        try {
          return cacheCollectionKey(client.databaseName, resolve(name));
        } catch {
          return cacheCollectionKey(client.databaseName, name);
        }
      });

    const runOnce = (): Promise<T> => {
      if (useCache && key) {
        // Capture the version of EVERY source collection before fetching so a
        // write to any of them mid-flight can never be hidden by a late set.
        const sourceKeys = toSourceKeys();
        const primaryKey = cacheCollectionKey(client.databaseName, physical);
        const versions: Record<string, number> = { [primaryKey]: cache!.versionOf(primaryKey) };
        for (const col of sourceKeys) {
          if (!(col in versions)) versions[col] = cache!.versionOf(col);
        }
        const hit = cache!.get(key) as T | undefined;
        if (hit !== undefined) return Promise.resolve(hit);
        return runDriver().then((value) => {
          cache!.set(key, value, undefined, sourceKeys, versions);
          return value;
        });
      }
      return runDriver();
    };

    if (shouldDedupe) {
      const dedupeKey = `${cacheCollectionKey(client.databaseName, physical)}|${opName}|${stableHash([pipeline, options])}`;
      return opts.inFlight!.run(dedupeKey, runOnce);
    }
    return runOnce();
  };
};
