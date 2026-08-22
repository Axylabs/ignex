/**
 * Replica-mode change-stream watchers: one long-lived `$changeStream` consumer
 * per (database, collection); every data change invalidates the queries bound
 * to that collection (event-driven, works across processes and external
 * writers).
 *
 * A strategy object owned by `HotCache` (see `./index.ts`). The host supplies
 * the registered queries, per-collection invalidation, and the mode-fallback
 * callback. On permanent "not supported" errors the watcher drops the stream
 * and, when every planned stream has failed, tells the host to flip to the
 * standalone ticker. Transient errors retry with jittered backoff.
 *
 * ## Failure semantics (the staleness window)
 *
 * `watchLoop` is the self-healing consumer. Any stream error or server-side
 * kill (network drop, replica failover, cursor invalidation) is logged, the
 * abandoned stream is closed, and the loop reconnects after a jittered backoff
 * (1s → 5s). On every REOPEN (`backoff > 0`) the bound collection is
 * invalidated **once**, dropping cached entries so anything written during the
 * outage is re-fetched on the next read — this "invalidate-on-reopen" is what
 * restores correctness after:
 *
 *   - **Resume-token expiry** — a `ChangeStreamHistoryLost`/invalid-token error.
 *     It is a recoverable error, NOT "not supported", so it stays in the retry
 *     path. The re-opened stream has no resume token and starts from "now"; the
 *     invalidate-on-reopen drops entries that could be stale.
 *   - **Rollback / `invalidate` events** — a dropped or renamed collection emits
 *     an `invalidate` event that ends the stream; the loop reconnects and
 *     invalidates on reopen.
 *   - **Consumer downtime** — while the consumer is down, writes are NOT
 *     observed, so the in-process LRU keeps serving stale values (the inherent
 *     tradeoff: low latency can hide stale reads). Staleness is bounded only by
 *     reconnect latency + the invalidate-on-reopen, plus any per-query
 *     `ttlMs`/`refreshIntervalMs`. A consumer that never reconnects leaves
 *     entries stale forever unless TTL/refresh are set.
 */
import type { ChangeStream } from "mongodb";
import type { LoggerLike } from "../../utils/logger.ts";
import { sleepJittered } from "../../utils/timeout.ts";
import { isPermanentWatchError } from "../../utils/watch-errors.ts";
import { type HotCollectionRef, type RegisteredQuery, WATCH_SEP } from "./types.ts";

export interface WatchHost {
  /** All registered queries (their `watch` refs drive which streams to open). */
  queries: () => Map<string, RegisteredQuery>;
  /** Invalidate every query bound to a physical collection. */
  invalidateCollection: (collection: string) => void;
  /** Whether the cache is currently in replica mode (used before a fallback). */
  isReplica: () => boolean;
  /** Flip the cache to standalone mode + start the ticker (called after a total fallback). */
  fallbackToStandalone: () => void;
  logger: LoggerLike;
}

/** Long-lived change-stream coordinator for replica mode. */
export class WatchCoordinator {
  private streams = new Map<string, ChangeStream>();
  private failedStreams = new Set<string>();
  private stopped = true;

  constructor(private host: WatchHost) {}

  /** Number of currently open change streams. */
  get size(): number {
    return this.streams.size;
  }

  /** Mark the coordinator as running and open watchers for all watch refs (idempotent). */
  start(): void {
    this.stopped = false;
    this.openWatchStreams();
  }

  /** Close every watcher and clear failure bookkeeping (idempotent). */
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
    this.failedStreams.clear();
    await Promise.allSettled(closes);
  }

  private openWatchStreams(): void {
    const seen = new Set<string>();
    for (const q of this.host.queries().values()) {
      for (const ref of q.config.watch ?? []) {
        const key = `${ref.db.databaseName}${WATCH_SEP}${ref.collection}`;
        if (seen.has(key) || this.streams.has(key)) continue;
        seen.add(key);
        void this.watchLoop(key, ref);
      }
    }
  }

  /**
   * Long-lived change-stream consumer for one collection. Each data change
   * invalidates the queries bound to it. On permanent "not supported" errors the
   * watcher is dropped and, if every planned stream failed, the cache falls back
   * to the standalone ticker. Transient errors (including resume-token expiry,
   * rollbacks, and `invalidate` events) retry with backoff and invalidate the
   * collection on reopen so entries missed during the outage are re-fetched —
   * see the module doc for the full failure-semantics contract.
   */
  private async watchLoop(key: string, ref: HotCollectionRef): Promise<void> {
    let backoff = 0;
    while (!this.stopped) {
      try {
        const stream = ref.db.collection(ref.collection).watch([]);
        stream.on("error", () => {});
        this.streams.set(key, stream);
        if (backoff > 0) {
          // This stream is a RECONNECT after an error — changes made during the
          // outage were missed, so drop any entries they may have affected.
          this.host.logger.warn?.(
            { collection: ref.collection },
            "hot cache: change stream reconnected — invalidating collection to drop entries missed during the outage",
          );
          this.host.invalidateCollection(ref.collection);
        }
        const iterator = stream[Symbol.asyncIterator]();
        for await (const _change of iterator) {
          this.host.invalidateCollection(ref.collection);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.host.logger.warn?.(
          { error: message, collection: ref.collection },
          "hot cache change stream error",
        );
        // Close the abandoned stream before the retry loop re-opens one, so a
        // transient error never leaks a ChangeStream cursor.
        const abandoned = this.streams.get(key);
        this.streams.delete(key);
        if (abandoned) {
          try {
            await abandoned.close();
          } catch {
            // Best-effort: the server drops the cursor on disconnect anyway.
          }
        }
        // Classify permanent errors ONLY by the definitive standalone + auth
        // verdicts (see isPermanentWatchError). A broad pattern (e.g. `not
        // supported` or `ChangeStream`) can misfire on replica errors like
        // "change stream history lost" (resume-token expiry) and wrongly flip
        // the cache to the standalone ticker — those must stay in the retry
        // path, where the invalidate-on-reopen restores correctness.
        if (isPermanentWatchError(message)) {
          this.markStreamFailed(key);
          return;
        }
      }
      if (this.stopped) return;
      backoff = Math.min(backoff + 1000, 5000);
      await sleepJittered(backoff, 1000, true);
    }
  }

  private markStreamFailed(key: string): void {
    this.failedStreams.add(key);
    if (!this.host.isReplica()) return;
    const planned = this.plannedStreamKeys();
    if (planned.size > 0 && [...planned].every((k) => this.failedStreams.has(k))) {
      this.host.logger.warn?.({}, "hot cache: change streams unsupported, falling back to ticker");
      this.host.fallbackToStandalone();
    }
  }

  private plannedStreamKeys(): Set<string> {
    const set = new Set<string>();
    for (const q of this.host.queries().values()) {
      for (const ref of q.config.watch ?? []) {
        set.add(`${ref.db.databaseName}${WATCH_SEP}${ref.collection}`);
      }
    }
    return set;
  }
}
