/**
 * @fileoverview Redis-backed rate-limit state — ATOMIC shared limiting across
 * instances.
 *
 * The generic read→compute→write flow in the rate-limit plugin is non-atomic:
 * N replicas each read `count=k`, all write `k+1`, and the effective ceiling
 * drifts toward `N × maxRequests`. This adapter closes that gap for the
 * fixed-window algorithm with one Lua call: increment, establish/repair the
 * TTL, and return the real reset deadline as one atomic operation.
 *
 * Sliding-window
 * and token-bucket algorithms are NOT supported here (they need multi-step
 * state); use them with an in-process LRU or implement a custom store.
 */
import type { FixedWindowEntry } from "../ratelimit";

/** Minimal ioredis surface used by the atomic limiter. */
export interface RedisRateLimitClientLike {
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
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
      const result = await client.eval(
        `local count = redis.call("INCR", KEYS[1])
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}`,
        1,
        keyFor(key),
        Math.max(1, windowMs),
      );
      if (
        !Array.isArray(result) ||
        typeof result[0] !== "number" ||
        typeof result[1] !== "number"
      ) {
        throw new Error("Redis rate-limit script returned an invalid result");
      }
      return { count: result[0], resetTime: now + result[1] };
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
