/**
 * A self-contained DataLoader — batch + cache loading that eliminates the
 * N+1 query problem (the classic GraphQL utility, implemented from scratch so
 * the ORM owns its batching behavior).
 *
 * Semantics:
 *  - concurrent `load(key)` calls made in the same tick are coalesced into ONE
 *    `batch(keys)` call (flushed on a microtask, or after `maxBatchDelayMs`)
 *  - the batch result is a Map (key → value); a missing key resolves `undefined`
 *  - results are cached per key (canonicalized via `keyOf`) for the loader's
 *    lifetime; `clear`/`clearAll` reset the cache
 *  - a FAILED batch is never cached: its keys are evicted so a later `load`
 *    runs a fresh batch instead of re-surfacing the same rejection
 *  - `maxBatchSize` splits oversized batches
 */

export interface DataLoaderOptions<Key, Value> {
  /** Resolve a batch of keys → one Map. Keys that have no row should be absent. */
  batch: (keys: Key[]) => Promise<Map<Key, Value>>;
  /** Max keys per batch call (default 1000). */
  maxBatchSize?: number;
  /** Flush delay in ms (default 0 → microtask flush, i.e. one tick batching). */
  maxBatchDelayMs?: number;
  /** Cache loaded values (default true). */
  cache?: boolean;
  /** Canonical key function for value-based keys (ObjectId, Date, ...). */
  keyOf?: (key: Key) => string;
  cacheMap?: Map<string, Promise<Value | undefined>>;
}

interface QueueItem<Key, Value> {
  key: Key;
  canonicalKey: string;
  /** The promise returned to the caller — kept so a failed batch can evict exactly this cache entry. */
  promise: Promise<Value | undefined>;
  resolve: (value: Value | undefined) => void;
  reject: (error: unknown) => void;
}

export class DataLoader<Key, Value> {
  private readonly batchFn: (keys: Key[]) => Promise<Map<Key, Value>>;
  private readonly maxBatchSize: number;
  private readonly maxBatchDelayMs: number;
  private readonly cacheEnabled: boolean;
  private readonly keyOf: (key: Key) => string;
  private readonly cache: Map<string, Promise<Value | undefined>>;

  private queue: Array<QueueItem<Key, Value>> = [];
  private scheduled = false;
  private flushing = false;

  constructor(options: DataLoaderOptions<Key, Value>) {
    this.batchFn = options.batch;
    this.maxBatchSize = options.maxBatchSize ?? 1000;
    this.maxBatchDelayMs = options.maxBatchDelayMs ?? 0;
    this.cacheEnabled = options.cache ?? true;
    this.keyOf = options.keyOf ?? ((key: Key): string => `${typeof key}:${String(key)}`);
    this.cache = options.cacheMap ?? new Map();
  }

  /** Load one key. Concurrent loads are batched; cached keys resolve instantly. */
  load(key: Key): Promise<Value | undefined> {
    const canonicalKey = this.keyOf(key);
    if (this.cacheEnabled) {
      const cached = this.cache.get(canonicalKey);
      if (cached) return cached;
    }

    let resolve!: (value: Value | undefined) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Value | undefined>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.queue.push({ key, canonicalKey, promise, resolve, reject });
    if (this.cacheEnabled) this.cache.set(canonicalKey, promise);

    this.scheduleFlush();
    return promise;
  }

  /** Load many keys (each resolves independently). */
  loadMany(keys: readonly Key[]): Promise<Array<Value | undefined>> {
    return Promise.all(keys.map((key) => this.load(key)));
  }

  clear(key: Key): this {
    this.cache.delete(this.keyOf(key));
    return this;
  }

  clearAll(): this {
    this.cache.clear();
    return this;
  }

  /** Pre-populate the cache without hitting the batch function. */
  prime(key: Key, value: Value): this {
    if (this.cacheEnabled) this.cache.set(this.keyOf(key), Promise.resolve(value));
    return this;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  private scheduleFlush(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    if (this.maxBatchDelayMs > 0) {
      setTimeout(() => {
        void this.flush();
      }, this.maxBatchDelayMs);
    } else {
      queueMicrotask(() => {
        void this.flush();
      });
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.queue.length === 0) {
      this.scheduled = false;
      return;
    }

    const items = this.queue.splice(0, this.maxBatchSize);
    this.flushing = true;
    try {
      const resultMap = await this.batchFn(items.map((item) => item.key));
      for (const item of items) {
        item.resolve(resultMap.get(item.key));
      }
    } catch (error) {
      for (const item of items) {
        // Never cache a failure: evict this exact promise (guarded by identity
        // so a newer load of the same key created mid-batch is left intact),
        // then reject — a later load will run a fresh batch.
        if (this.cacheEnabled && this.cache.get(item.canonicalKey) === item.promise) {
          this.cache.delete(item.canonicalKey);
        }
        item.reject(error);
      }
    } finally {
      this.flushing = false;
      this.scheduled = false;
      if (this.queue.length > 0) {
        this.scheduled = true;
        queueMicrotask(() => {
          void this.flush();
        });
      }
    }
  }
}

/** Canonical key for value-comparison keys (ObjectId → hex, primitives → typed string). */
export const canonicalKey = (value: unknown): string => {
  if (value === undefined || value === null) return "null";
  if (typeof value === "object") {
    const anyValue = value as { toHexString?: () => string };
    if (typeof anyValue.toHexString === "function") return `oid:${anyValue.toHexString()}`;
    if (value instanceof Date) return `date:${value.getTime()}`;
  }
  return `${typeof value}:${String(value)}`;
};
