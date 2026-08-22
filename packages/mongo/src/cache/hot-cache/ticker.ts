/**
 * Standalone-mode background refresh: a single global `setInterval` ticker that
 * re-runs the loaders of due entries and swaps the fresh values in. Stale values
 * keep being served until the swap (bounded staleness, reads never block).
 *
 * A strategy object owned by `HotCache` (see `./index.ts`); the host supplies
 * the registered queries, the fetch pipeline, and the logger via `TickerHost`.
 */
import type { LoggerLike } from "../../utils/logger.ts";
import type { RegisteredQuery } from "./types.ts";

export interface TickerHost {
  /** All registered queries (the ticker mutates their counters/refresh timestamps). */
  queries: () => Map<string, RegisteredQuery>;
  /** The shared read-through fetch pipeline (with in-flight dedup + gen guard). */
  fetch: (
    q: RegisteredQuery,
    key: string,
    args: readonly unknown[],
    gen: number,
  ) => Promise<unknown>;
  logger: LoggerLike;
}

/** Global standalone refresh ticker. Owns the timer; stops cleanly via `stop()`. */
export class RefreshTicker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private intervalMs: number;

  constructor(
    private host: TickerHost,
    tickIntervalMs: number,
  ) {
    this.intervalMs = tickIntervalMs;
  }

  /** Whether the timer is currently running. */
  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Start the interval (idempotent). The timer is `.unref()`'d so it never holds the process open. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.host.logger.warn?.(
          { error: err instanceof Error ? err.message : String(err) },
          "hot cache tick failed",
        );
      }
    }, this.intervalMs);
    // Don't keep the process alive on a lone timer (serverless/CLI friendly).
    const t = this.timer as { unref?: () => unknown } | undefined;
    t?.unref?.();
  }

  /** Stop the interval (idempotent). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Background refresh pass: re-run loaders for due entries, swap fresh values. */
  private tick(): void {
    const now = Date.now();
    for (const q of this.host.queries().values()) {
      if (q.refreshIntervalMs <= 0) continue;
      for (const [key, entry] of [...q.lru.entries()]) {
        if (entry.nextRefreshAt <= now) {
          q.refreshes++;
          void this.host.fetch(q, key, entry.args, q.gen).catch((err) => {
            const current = q.lru.peek(key);
            if (current) current.nextRefreshAt = now + q.refreshIntervalMs;
            this.host.logger.warn?.(
              {
                error: err instanceof Error ? err.message : String(err),
                query: q.name,
              },
              "hot cache background refresh failed (stale value retained)",
            );
          });
        }
      }
    }
  }

  /**
   * In standalone mode the ticker only refreshes queries with an explicit
   * `refreshIntervalMs`. A query with neither `refreshIntervalMs` nor `ttlMs`
   * set is served until it is manually invalidated — an easy way to serve
   * unbounded-stale data. Surface those queries once so the operator opts in
   * deliberately.
   */
  warnUnboundedStaleness(): void {
    const unbounded = [...this.host.queries().values()].filter(
      (q) => q.refreshIntervalMs <= 0 && q.ttlMs <= 0,
    );
    if (unbounded.length === 0) return;
    this.host.logger.warn?.(
      { queries: unbounded.map((q) => q.name) },
      "hot cache: standalone mode — these queries have no refreshIntervalMs/ttlMs, so values are served until manually invalidated (unbounded staleness); set refreshIntervalMs or ttlMs to bound it",
    );
  }
}
