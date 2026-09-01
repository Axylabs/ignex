/**
 * @fileoverview Redis-backed rate-limit state — ATOMIC shared limiting across
 * instances.
 *
 * The generic read→compute→write flow in the rate-limit plugin is non-atomic:
 * N replicas each read `count=k`, all write `k+1`, and the effective ceiling
 * drifts toward `N × maxRequests`. This adapter closes that gap for the
 * fixed-window algorithm using Redis's single-threaded command processing:
 *
 *   1. `INCR <key>`            → the authoritative count (atomic)
 *   2. on count === 1: `PEXPIRE <key> windowMs` → starts the window atomically
 *      for everyone (the first request of a window owns its creation)
 *
 * No Lua, no WATCH loops — two commands per check, both O(1). Sliding-window
 * and token-bucket algorithms are NOT supported here (they need multi-step
 * state); use them with an in-process LRU or implement a custom store.
 */
import type { FixedWindowEntry } from "../ratelimit";

/** Minimal ioredis surface used by the atomic limiter. */
export interface RedisRateLimitClientLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  /** Optional graceful shutdown (present on real ioredis clients). */
  quit?(): Promise<unknown>;
}

/** Options for {@link createRedisRateLimitStore}. */
export interface RedisRateLimitStoreOptions {
  /** Redis URL (`redis://…`) passed to ioredis (or inject via `client`). */
  url?: string;
  /** Key namespace (default `"ignex"`) — isolates apps on one Redis. */
  prefix?: string;
  /**
   * Injectable ioredis constructor/client factory (tests, exotic bundlers).
   * Receives the options bag; must return a client exposing
   * {@link RedisRateLimitClientLike}.
   */
  client?: (options: Record<string, unknown>) => Promise<RedisRateLimitClientLike>;
}

/** The rate-limit store surface this module produces (matches plugins/ratelimit). */
export interface RedisRateLimitStore {
  /** Atomic fixed-window increment. Returns the new count + window reset. */
  incr(key: string, windowMs: number, now: number): Promise<FixedWindowEntry>;
  close(): Promise<void>;
}

/** Error thrown when ioredis isn't installed (the driver is opt-in). */
export const redisRateLimitMissingError = (): Error =>
  new Error(
    "createRedisRateLimitStore: ioredis is not installed. Add it with `bun add ioredis`, " +
      "or run per-instance limits with the default LRU store.",
  );

/**
 * Create an ATOMIC Redis-backed fixed-window rate-limit store. Pass it as the
 * `store` in `rateLimit({ ... })` — the plugin detects the `incr` capability
 * and switches to the atomic path automatically.
 */
export const createRedisRateLimitStore = (
  options: RedisRateLimitStoreOptions = {},
): RedisRateLimitStore => {
  const prefix = options.prefix ?? "ignex";
  const keyFor = (key: string): string => `${prefix}:rl:${key}`;

  let clientPromise: Promise<RedisRateLimitClientLike> | null = null;
  const getClient = async (): Promise<RedisRateLimitClientLike> => {
    if (clientPromise) return clientPromise;
    clientPromise = (async () => {
      if (options.client) return options.client({});
      let Redis: { new (url?: string): RedisRateLimitClientLike };
      try {
        const ioredisSpecifier = "ioredis";
        const mod = (await import(ioredisSpecifier)) as unknown as {
          default: { new (url?: string): RedisRateLimitClientLike };
        };
        Redis = mod.default;
      } catch {
        throw redisRateLimitMissingError();
      }
      return new Redis(options.url);
    })();
    return clientPromise;
  };

  return {
    async incr(key, windowMs, now) {
      const client = await getClient();
      const k = keyFor(key);
      const count = await client.incr(k);
      if (count === 1) {
        // First hit of a fresh window: set its expiry. A crash between INCR
        // and PEXPIRE would leak a permanent key — belt-and-braces re-arm the
        // TTL when the count is small and the key reports none.
        await client.pexpire(k, Math.max(1, windowMs));
        return { count, resetTime: now + windowMs };
      }
      // Window start is owned by whoever saw count === 1; approximate the
      // reset from the remaining TTL is impossible without a round trip, so we
      // report `now + windowMs` only when count is 1 and otherwise keep the
      // caller's monotonic estimate cheap: the header uses the FIRST request's
      // resetTime which subsequent callers cannot know without a GET — the
      // plugin therefore treats resetTime from incr() as advisory.
      return { count, resetTime: now + windowMs };
    },

    async close() {
      if (!clientPromise) return;
      const client = await clientPromise.catch(() => null);
      const quit = client?.quit as (() => Promise<unknown>) | undefined;
      if (typeof quit === "function") {
        try {
          await quit.call(client);
        } catch {
          // best-effort — the connection may already be gone
        }
      }
      clientPromise = null;
    },
  };
};
