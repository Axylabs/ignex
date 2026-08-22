/**
 * Optional change-stream watchers that invalidate the shared query cache on
 * EXTERNAL writes — other processes, the raw `client` escape hatch, or direct
 * DB writes — closing the write-through-only gap of the ORM `QueryCache`.
 *
 * Requires a replica set / mongos. On standalone servers `$changeStream` is
 * rejected, so the invalidator logs a warning once and disables itself (the
 * cache then stays write-through only — see `MongoServiceConfig.cacheWatch`).
 *
 * One watcher is opened per unique (database, physical collection); any change
 * invalidates every cached read for that collection via
 * `QueryCache.invalidateByCollection`. Watchers self-heal: transient errors
 * retry with backoff and the collection is re-invalidated on reopen, so
 * changes missed during an outage don't leave stale entries behind.
 */
import type { ChangeStream, Db } from "mongodb";
import type { QueryCache } from "../cache/query-cache.ts";
import { cacheCollectionKey } from "../cache/query-cache.ts";
import type { LoggerLike } from "../utils/logger.ts";
import { sleepJittered } from "../utils/timeout.ts";
import { isPermanentWatchError } from "../utils/watch-errors.ts";

/** A collection whose external writes should invalidate cached reads. */
export interface CacheInvalidationRef {
  /** Raw `Db` handle (e.g. `service.db.primaryClient.client`). */
  db: Db;
  /** PHYSICAL collection name — cache keys use it, so invalidation must too. */
  collection: string;
}

const SEP = "\u0000";

export class CacheInvalidator {
  private cache: QueryCache;
  private logger: LoggerLike;
  private streams = new Map<string, ChangeStream>();
  private disabled = false;
  private stopped = true;
  private warnedUnsupported = false;

  constructor(options: { cache: QueryCache; logger: LoggerLike }) {
    this.cache = options.cache;
    this.logger = options.logger;
  }

  /** Number of currently open change streams. */
  get size(): number {
    return this.streams.size;
  }

  /**
   * Open one watcher per unique (database, physical collection). Idempotent:
   * already-open streams are skipped; after `stop()` a later `start()` reopens.
   * Never throws — failures are logged (on unsupported servers it disables once).
   */
  async start(refs: CacheInvalidationRef[]): Promise<void> {
    if (this.disabled) return;
    this.stopped = false;
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = `${ref.db.databaseName}${SEP}${ref.collection}`;
      if (seen.has(key) || this.streams.has(key)) continue;
      seen.add(key);
      void this.watchLoop(key, ref);
    }
  }

  /** Close every watcher. Safe to call repeatedly, and before any `start`. */
  async stop(): Promise<void> {
    this.stopped = true;
    const closes = [...this.streams.values()].map((stream) => {
      try {
        return Promise.resolve(stream.close()).catch(() => {});
      } catch {
        return Promise.resolve();
      }
    });
    this.streams.clear();
    await Promise.allSettled(closes);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: watch/retry loop is inherently branchy
  private async watchLoop(key: string, ref: CacheInvalidationRef): Promise<void> {
    let backoff = 0;
    while (!this.stopped) {
      try {
        const stream = ref.db.collection(ref.collection).watch([]);
        stream.on("error", () => {});
        this.streams.set(key, stream);
        if (backoff > 0) {
          // Reconnect after an outage: changes during the gap were missed, so
          // drop the collection's cache to force a re-fetch on the next read.
          this.cache.invalidateByCollection(
            cacheCollectionKey(ref.db.databaseName, ref.collection),
          );
        }
        const iterator = stream[Symbol.asyncIterator]();
        for await (const _change of iterator) {
          this.cache.invalidateByCollection(
            cacheCollectionKey(ref.db.databaseName, ref.collection),
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const abandoned = this.streams.get(key);
        this.streams.delete(key);
        if (abandoned) {
          try {
            await abandoned.close();
          } catch {
            // Best-effort — the server drops the cursor on disconnect anyway.
          }
        }
        if (isPermanentWatchError(message)) {
          // Every collection shares the same server, so one permanent verdict
          // applies to all — disable once and stop retrying. NOTE: match ONLY
          // definitive permanent errors; replica errors like "change stream
          // history lost" (collection dropped) or resume-token expiry must stay
          // in the retry path.
          this.disabled = true;
          if (!this.warnedUnsupported) {
            this.warnedUnsupported = true;
            this.logger.warn?.(
              { collection: ref.collection, error: message },
              "cacheWatch: change streams unavailable permanently — the query cache stays write-through only; set cache: { ttlMs } or disable cacheWatch",
            );
          }
          return;
        }
        if (this.stopped) return;
        this.logger.warn?.(
          { error: message, collection: ref.collection },
          "cacheWatch: change stream error, retrying with backoff",
        );
        backoff = Math.min(backoff + 1000, 5000);
        await sleepJittered(backoff, 1000, true);
      }
    }
  }
}
