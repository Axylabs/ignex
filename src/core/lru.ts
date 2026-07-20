/**
 * @fileoverview Production LRU cache backed by lru-cache.
 * Preserves your existing API.
 */

import { LRUCache as LRU } from "lru-cache";

export interface LRUCacheOptions<K, V> {
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

export class LRUCache<K, V> {
  private lru: LRU<K, Entry<V>>;
  private inflight = new Map<K, Promise<V>>();

  constructor(private readonly opts: LRUCacheOptions<K, V> = {}) {
    this.lru = new LRU<K, Entry<V>>({
      max: opts.max ?? 1000,
      maxSize: opts.maxBytes,
      sizeCalculation: (entry) => Math.max(1, entry.bytes),
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
    return entry.expiresAt === 0 || entry.expiresAt > now;
  }

  private fresh(entry: Entry<V>, now: number): boolean {
    return entry.staleAt === 0 || entry.staleAt > now;
  }

  get(key: K, _options: { allowStale?: boolean } = {}): V | undefined {
    const entry = this.lru.get(key);
    if (!entry) return undefined;

    const now = this.now();

    if (!this.alive(entry, now)) {
      this.lru.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(
    key: K,
    value: V,
    options: { ttlMs?: number; staleTtlMs?: number; bytes?: number } = {}
  ): this {
    const ttlMs = options.ttlMs ?? this.opts.ttlMs ?? 0;
    const staleTtlMs = options.staleTtlMs ?? this.opts.staleTtlMs ?? 0;
    const bytes = options.bytes ?? this.opts.sizeOf?.(value, key) ?? 0;
    const maxBytes = this.opts.maxBytes ?? 0;

    if (maxBytes > 0 && bytes > maxBytes) return this;

    const now = this.now();
    const expiresAt = ttlMs > 0 ? now + ttlMs : 0;
    const staleAt = staleTtlMs > 0 ? now + staleTtlMs : expiresAt;
    const lruTtl = Math.max(ttlMs, staleTtlMs);

    this.lru.set(
      key,
      { value, bytes, expiresAt, staleAt },
      lruTtl > 0 ? { ttl: lruTtl } : undefined
    );

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
    options: { ttlMs?: number; staleTtlMs?: number; bytes?: number } = {}
  ): Promise<V> {
    const now = this.now();
    const entry = this.lru.get(key);

    if (entry && this.alive(entry, now)) {
      if (!this.fresh(entry, now) && !this.inflight.has(key)) {
        const revalidate = Promise.resolve()
          .then(factory)
          .then((value) => this.set(key, value, options))
          .catch(() => {
            // keep stale value on failure
          })
          .finally(() => {
            this.inflight.delete(key);
          });

        this.inflight.set(key, revalidate as Promise<V>);
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