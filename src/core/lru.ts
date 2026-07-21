/**
 * Production LRU cache backed by lru-cache.
 *
 * Design:
 * - Strict key constraint
 * - Pure entry factory
 * - No explicit undefined option properties
 * - Single-flight getOrSet
 */
import { LRUCache as LRU } from "lru-cache";

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
  expiresAt: number;
  staleAt: number;
}

interface WriteOptions {
  ttlMs?: number;
  staleTtlMs?: number;
  bytes?: number;
}

/**
 * Create a cache entry with resolved expiry metadata.
 */
const createEntry = <V>(
  value: V,
  bytes: number,
  ttlMs: number,
  staleTtlMs: number,
  now: number,
): Entry<V> => {
  const expiresAt = ttlMs > 0 ? now + ttlMs : 0;
  const staleAt = staleTtlMs > 0 ? now + staleTtlMs : expiresAt;

  return {
    value,
    bytes,
    expiresAt,
    staleAt,
  };
};

export class LRUCache<K extends {}, V> {
  private lru: LRU<K, Entry<V>>;
  private inflight = new Map<K, Promise<V>>();

  constructor(private readonly opts: LRUCacheOptions<K, V> = {}) {
    this.lru = new LRU<K, Entry<V>>({
      max: opts.max ?? 1000,
      sizeCalculation: (entry) => Math.max(1, entry.bytes),
      dispose: (entry, key) => {
        opts.onEvict?.(key, entry.value);
      },
      ...(opts.maxBytes !== undefined ? { maxSize: opts.maxBytes } : {}),
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
    return entry.expiresAt === 0 || entry.expiresAt > now;
  }

  private fresh(entry: Entry<V>, now: number): boolean {
    return entry.staleAt === 0 || entry.staleAt > now;
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

    const entry = createEntry(value, bytes, ttlMs, staleTtlMs, this.now());
    const lruTtl = Math.max(ttlMs, staleTtlMs);

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

  async getOrSet(
    key: K,
    factory: () => Promise<V> | V,
    options: WriteOptions = {},
  ): Promise<V> {
    const now = this.now();
    const entry = this.lru.get(key);

    if (entry && this.alive(entry, now)) {
      if (!this.fresh(entry, now) && !this.inflight.has(key)) {
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