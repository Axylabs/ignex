/**
 * Production LRU cache backed by lru-cache.
 *
 * Bun 1.4 edition:
 * - correct fresh/stale/expire semantics
 * - single-flight getOrSet
 * - stale-while-revalidate background revalidation
 */

import { LRUCache as LRU } from "lru-cache";

/** Options for {@link LRUCache}. */
export interface LRUCacheOptions<K extends {}, V> {
  max?: number;
  ttlMs?: number;
  staleTtlMs?: number;
  maxBytes?: number;
  sizeOf?: (value: V, key: K) => number;
  onEvict?: (key: K, value: V) => void;
}

interface Entry<V> {
  value: V;
  bytes: number;
  freshUntil: number;
  staleUntil: number;
  expireUntil: number;
}

interface WriteOptions {
  ttlMs?: number;
  staleTtlMs?: number;
  bytes?: number;
}

const createEntry = <V>(
  value: V,
  bytes: number,
  ttlMs: number,
  staleTtlMs: number,
  now: number,
): Entry<V> => {
  const freshTtl = ttlMs > 0 ? ttlMs : 0;

  const staleTtl = staleTtlMs > 0 ? Math.max(staleTtlMs, ttlMs) : freshTtl;

  const freshUntil = freshTtl > 0 ? now + freshTtl : 0;
  const staleUntil = staleTtl > 0 ? now + staleTtl : freshUntil;
  const expireUntil = staleUntil || freshUntil;

  return {
    value,
    bytes,
    freshUntil,
    staleUntil,
    expireUntil,
  };
};

/**
 * A bounded LRU cache with fresh/stale/expire semantics, single-flight
 * `getOrSet`, and stale-while-revalidate background refresh.
 *
 * Entries are evicted by count (`max`) and optionally total bytes (`maxBytes`).
 * `ttlMs: 0` (default) means entries never expire by time.
 */
export class LRUCache<K extends {}, V> {
  private lru: LRU<K, Entry<V>>;
  private inflight = new Map<K, Promise<V>>();

  constructor(private readonly opts: LRUCacheOptions<K, V> = {}) {
    this.lru = new LRU<K, Entry<V>>({
      max: opts.max ?? 1000,
      // `maxSize`/`sizeCalculation` are only wired when maxBytes is set —
      // lru-cache v11 throws if sizeCalculation is provided without maxSize.
      ...(opts.maxBytes !== undefined
        ? { maxSize: opts.maxBytes, sizeCalculation: (entry) => Math.max(1, entry.bytes) }
        : {}),
      dispose: (entry, key) => {
        opts.onEvict?.(key, entry.value);
      },
    });
  }

  get size(): number {
    return this.lru.size;
  }

  get byteSize(): number {
    return this.lru.calculatedSize;
  }

  private now(): number {
    return Date.now();
  }

  private alive(entry: Entry<V>, now: number): boolean {
    return entry.expireUntil === 0 || entry.expireUntil > now;
  }

  private fresh(entry: Entry<V>, now: number): boolean {
    return entry.freshUntil === 0 || entry.freshUntil > now;
  }

  get(key: K, options: { allowStale?: boolean } = {}): V | undefined {
    const entry = this.lru.get(key);
    if (!entry) return undefined;

    const now = this.now();

    if (!this.alive(entry, now)) {
      this.lru.delete(key);
      return undefined;
    }

    if (!options.allowStale && !this.fresh(entry, now)) {
      return undefined;
    }

    return entry.value;
  }

  set(key: K, value: V, options: WriteOptions = {}): this {
    const ttlMs = options.ttlMs ?? this.opts.ttlMs ?? 0;
    const staleTtlMs = options.staleTtlMs ?? this.opts.staleTtlMs ?? 0;
    const bytes = options.bytes ?? this.opts.sizeOf?.(value, key) ?? 0;

    const maxBytes = this.opts.maxBytes ?? 0;
    if (maxBytes > 0 && bytes > maxBytes) return this;

    const now = this.now();
    const entry = createEntry(value, bytes, ttlMs, staleTtlMs, now);

    const lruTtl = entry.expireUntil > 0 ? entry.expireUntil - now : 0;

    if (lruTtl > 0) {
      this.lru.set(key, entry, { ttl: lruTtl });
    } else {
      this.lru.set(key, entry);
    }

    return this;
  }

  delete(key: K): boolean {
    return this.lru.delete(key);
  }

  clear(): void {
    this.lru.clear();
    this.inflight.clear();
  }

  async getOrSet(key: K, factory: () => Promise<V> | V, options: WriteOptions = {}): Promise<V> {
    const now = this.now();
    const entry = this.lru.get(key);

    if (entry && this.alive(entry, now)) {
      if (this.fresh(entry, now)) {
        return entry.value;
      }

      if (!this.inflight.has(key)) {
        const revalidate = Promise.resolve()
          .then(factory)
          .then((value) => {
            this.set(key, value, options);
            return value;
          })
          .catch(() => entry.value)
          .finally(() => {
            this.inflight.delete(key);
          });

        this.inflight.set(key, revalidate);
      }

      return entry.value;
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = Promise.resolve()
      .then(factory)
      .then((value) => {
        this.set(key, value, options);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);

    return promise;
  }
}
