/**
 * Minimal dependency-free LRU cache backed by a Map (recency = insertion order).
 * get() re-inserts the entry so the most-recently-used item is always last.
 */
export interface LRUOptions {
  /** Maximum number of entries before the least-recently-used item is evicted. Must be > 0. */
  max: number;
}

export class LRU<K, V> {
  readonly max: number;
  private map = new Map<K, V>();
  /** Number of entries evicted to make room for new ones (capacity evictions only). */
  evictions = 0;

  constructor(options: LRUOptions) {
    if (options.max <= 0) throw new Error("LRU max must be > 0");
    this.max = options.max;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest !== undefined) {
        this.map.delete(oldest);
        this.evictions++;
      }
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}
