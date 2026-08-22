/**
 * Generic keyed factory caches (memoization). Unlike the ORM's `QueryCache`
 * (per-collection, TTL, invalidation-aware) and `HotCache` (read-through,
 * event/timer-refreshed), these are dependency-free building blocks for
 * memoizing any expensive computation by key — including in-flight dedup so a
 * keyed factory never runs twice concurrently.
 */
import { LRU } from "./lru.ts";

export interface CacheOptions {
  /** Max cached entries. `0` or negative → unbounded Map (default 100). */
  maxSize?: number;
}

type BackingStore<K, V> = {
  get(k: K): V | undefined;
  set(k: K, v: V): void;
  has(k: K): boolean;
  delete(k: K): void;
};

const makeStore = <K, V>(maxSize: number): BackingStore<K, V> => {
  if (maxSize <= 0) {
    const map = new Map<K, V>();
    return {
      get: (k) => map.get(k),
      set: (k, v) => {
        map.set(k, v);
      },
      has: (k) => map.has(k),
      delete: (k) => {
        map.delete(k);
      },
    };
  }
  return new LRU<K, V>({ max: maxSize });
};

/**
 * Synchronous keyed factory cache: one value per key, LRU-bounded.
 * Used for cheap singleton factories (connection pools, resolvers, ...).
 */
export const createCachedFactory = <K, V>(
  factory: (key: K) => V,
  options: CacheOptions = {},
): ((key: K) => V) => {
  const maxSize = options.maxSize ?? 100;
  const cache = makeStore<K, V>(maxSize);
  return (key: K): V => {
    const existing = cache.get(key);
    if (existing !== undefined) return existing;
    const value = factory(key);
    cache.set(key, value);
    return value;
  };
};

/**
 * Async keyed factory cache with **in-flight deduplication**: concurrent calls
 * with the same key share a single Promise so the factory runs only once.
 * On settle (success or failure) the in-flight entry is removed.
 */
export const createCachedAsyncFactory = <K, V>(
  factory: (key: K) => Promise<V>,
  options: CacheOptions = {},
): ((key: K) => Promise<V>) => {
  const maxSize = options.maxSize ?? 100;
  const cache = makeStore<K, Promise<V>>(maxSize);
  const inFlight = new Map<K, Promise<V>>();

  return (key: K): Promise<V> => {
    const inflight = inFlight.get(key);
    if (inflight) return inflight;

    const cached = cache.get(key);
    if (cached) return cached;

    const promise = factory(key);
    inFlight.set(key, promise);
    cache.set(key, promise);
    promise.then(
      () => {
        inFlight.delete(key);
      },
      () => {
        inFlight.delete(key);
        // Never cache a failure — evict (identity-guarded) so the next call
        // retries instead of re-surfacing the same rejected promise.
        if (cache.get(key) === promise) cache.delete(key);
      },
    );
    return promise;
  };
};
