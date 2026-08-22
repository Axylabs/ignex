/**
 * @fileoverview Redis store driver — `createRedisStore` for the {@link Store}
 * contract, backed by ioredis (the standard Redis client).
 *
 * This is DX over the STANDARD approach: ioredis is the de-facto Redis client;
 * this driver adapts it to ignex's {@link Store} surface so sessions, jobs,
 * the HTTP cache, and rate-limit state can move to Redis with one line —
 * the cross-instance store the in-process memory/sqlite/file drivers can't
 * provide. Values are JSON-serialized (Redis strings), keys are namespaced
 * (`<prefix>:<key>`) so one Redis instance can serve several apps.
 *
 * TTL: `set` with `ttlMs`/`expiresAt` maps to `SET key value PX <ms>` (exact
 * wall-clock expiry). `get` uses `GET`; `delete` uses `DEL`; `touch` re-applies
 * the TTL via `PEXPIRE` (0 = never expires → `PERSIST`). All methods are async
 * (Redis is a network call) — callers `await` as with the other drivers.
 *
 * ```ts
 * import { createRedisStore } from "@ignex/core";
 *
 * const store = createRedisStore({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
 * await store.set("k", { a: 1 }, { ttlMs: 60_000 });
 * const v = await store.get("k");
 * await store.close();
 * ```
 */
import type { Store, StoreSetOptions } from "./types";

/** Options for {@link createRedisStore}. */
export interface RedisStoreOptions {
  /** Redis URL (`redis://…`) or connection options passed to ioredis. */
  url?: string;
  /** ioredis constructor options (host/port/password/…). */
  options?: Record<string, unknown>;
  /** Key namespace (default `"ignex"`) — isolates apps on one Redis. */
  prefix?: string;
  /** Default TTL in ms applied to `set` without explicit ttlMs (default none). */
  defaultTtlMs?: number;
  /**
   * Injectable ioredis constructor (default: lazy `import("ioredis")`). Exists
   * for tests and exotic bundlers; the returned object must expose the
   * {@link RedisLike} surface.
   */
  client?: new (
    urlOrOptions?: string | Record<string, unknown>,
  ) => RedisLike;
}

/** The ioredis surface the driver uses (typed loosely — optional dependency). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ms: number): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  persist(key: string): Promise<number>;
  quit(): Promise<unknown>;
}

/** Error thrown when ioredis isn't installed (the driver is opt-in). */
export const redisMissingError = (): Error =>
  new Error(
    "createRedisStore: ioredis is not installed. Add it with `bun add ioredis` " +
      "(the standard Redis client), or use the memory/sqlite/file store drivers.",
  );

/**
 * Create a Redis-backed {@link Store}. ioredis is loaded lazily (optional
 * dependency); all methods are async. Call `close()` on shutdown.
 */
export const createRedisStore = (options: RedisStoreOptions = {}): Store => {
  const prefix = options.prefix ?? "ignex";
  const defaultTtlMs = options.defaultTtlMs;
  const key = (raw: string): string => `${prefix}:${raw}`;

  let clientPromise: Promise<RedisLike> | null = null;
  const getClient = async (): Promise<RedisLike> => {
    if (clientPromise) return clientPromise;
    clientPromise = (async () => {
      let Redis: { new (urlOrOptions?: string | Record<string, unknown>): RedisLike };
      if (options.client) {
        Redis = options.client;
      } else {
        try {
          // Variable specifier keeps tsc from resolving the optional peer at
          // typecheck time (see mailer.ts for the same pattern).
          const ioredisSpecifier = "ioredis";
          const mod = (await import(ioredisSpecifier)) as {
            default: { new (urlOrOptions?: string | Record<string, unknown>): RedisLike };
          };
          Redis = mod.default;
        } catch {
          throw redisMissingError();
        }
      }
      return options.url ? new Redis(options.url) : new Redis(options.options ?? {});
    })();
    return clientPromise;
  };

  return {
    async get(rawKey) {
      const client = await getClient();
      const value = await client.get(key(rawKey));
      if (value === null) return null;
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return value; // non-JSON value stored directly (raw string)
      }
    },

    async set(rawKey, value, setOptions) {
      const client = await getClient();
      const k = key(rawKey);
      const serialized = JSON.stringify(value);
      const expiresAt = resolveRedisExpiry(setOptions, defaultTtlMs, Date.now());
      if (expiresAt > 0) {
        await client.set(k, serialized, "PX", expiresAt - Date.now());
      } else {
        await client.set(k, serialized);
      }
    },

    async delete(rawKey) {
      const client = await getClient();
      await client.del(key(rawKey));
    },

    async touch(rawKey, setOptions) {
      const client = await getClient();
      const k = key(rawKey);
      const expiresAt = resolveRedisExpiry(setOptions, defaultTtlMs, Date.now());
      if (expiresAt > 0) {
        await client.pexpire(k, expiresAt - Date.now());
      } else {
        await client.persist(k);
      }
    },

    async close() {
      if (!clientPromise) return;
      const client = await clientPromise.catch(() => null);
      if (client) {
        try {
          await client.quit();
        } catch {
          // best-effort — the connection may already be gone
        }
      }
      clientPromise = null;
    },
  };
};

/**
 * Resolve a write's absolute expiry in ms (same semantics as
 * {@link resolveExpiry}): `expiresAt` wins, else `now + ttlMs`, else
 * `defaultTtlMs`, else 0 (never).
 */
const resolveRedisExpiry = (
  options: StoreSetOptions | undefined,
  defaultTtlMs: number | undefined,
  now: number,
): number => {
  if (options?.expiresAt !== undefined) return options.expiresAt;
  const ttlMs = options?.ttlMs ?? defaultTtlMs;
  if (ttlMs === undefined) return 0;
  return ttlMs > 0 ? now + ttlMs : now;
};
