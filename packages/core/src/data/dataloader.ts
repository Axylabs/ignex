/**
 * DataLoader — per-request batching + caching + dedup.
 *
 * A classic DataLoader amortizes N concurrent `load(key)` calls into ONE
 * underlying `batchLoadFn(keys)` call, caches results for the loader's
 * lifetime (a per-request scope by default when created via `ctx.loader`),
 * and dedups concurrent loads of the same key so the batch function runs once
 * per unique key.
 *
 * Exposed "by default" on every request context as `ctx.loader(...)`.
 */
export type BatchLoadFn<Key, Value> = (keys: readonly Key[]) => Promise<readonly Value[]>;

export interface DataLoaderOptions<Key, Value, CacheKey = Key> {
  /** Max keys per batch; flush immediately when reached. Default: Infinity. */
  maxBatchSize?: number;
  /** Cache instance, or `false` to disable caching. Default: `new Map()`. */
  cache?: Map<CacheKey, Value> | false;
  /** Map a key to a cache key. Default: identity. */
  cacheKeyFn?: (key: Key) => CacheKey;
  /** Schedule a batch dispatch. Default: `queueMicrotask`. */
  batchScheduleFn?: (callback: () => void) => void;
}

export interface DataLoader<Key, Value> {
  /** Load a single key, batching it with concurrent loads. */
  load(key: Key): Promise<Value>;
  /** Load many keys; each resolves independently. */
  loadMany(keys: readonly Key[]): Promise<readonly Value[]>;
  /** Pre-populate the cache without invoking the batch function. */
  prime(key: Key, value: Value): DataLoader<Key, Value>;
  /** Invalidate a single cache entry. */
  clear(key: Key): DataLoader<Key, Value>;
  /** Invalidate the entire cache. */
  clearAll(): DataLoader<Key, Value>;
}

/** Factory shape assigned to `ctx.loader`. */
export type DataLoaderFactory = <Key, Value, CacheKey = Key>(
  batchLoadFn: BatchLoadFn<Key, Value>,
  options?: DataLoaderOptions<Key, Value, CacheKey>,
) => DataLoader<Key, Value>;

const identity = <K>(key: K): K => key;

interface BatchSubscriber<Value> {
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
}

interface BatchCallback<Value> {
  subscribers: BatchSubscriber<Value>[];
}

interface Batch<Key, Value, CacheKey> {
  hasDispatched: boolean;
  keys: Key[];
  /** cacheKey → first index in `keys`/`callbacks` (dedup within a batch). */
  keyIndices: Map<CacheKey, number>;
  callbacks: BatchCallback<Value>[];
}

const batchError = (expected: number, got: number): Error =>
  new Error(
    `DataLoader batchLoadFn must return one value per key (expected ${expected}, got ${got}).`,
  );

export const createDataLoader = <Key, Value, CacheKey = Key>(
  batchLoadFn: BatchLoadFn<Key, Value>,
  options: DataLoaderOptions<Key, Value, CacheKey> = {},
): DataLoader<Key, Value> => {
  const maxBatchSize = options.maxBatchSize ?? Number.POSITIVE_INFINITY;
  const cache = options.cache === false ? null : (options.cache ?? new Map<CacheKey, Value>());
  const cacheKeyFn = options.cacheKeyFn ?? (identity as (key: Key) => CacheKey);
  const batchScheduleFn =
    options.batchScheduleFn ?? ((callback: () => void): void => queueMicrotask(callback));

  let currentBatch: Batch<Key, Value, CacheKey> | null = null;

  const dispatch = async (batch: Batch<Key, Value, CacheKey>): Promise<void> => {
    batch.hasDispatched = true;
    if (batch.keys.length === 0) return;

    let values: readonly Value[];

    try {
      values = await batchLoadFn(batch.keys);
    } catch (error) {
      for (const cb of batch.callbacks) {
        for (const subscriber of cb.subscribers) subscriber.reject(error);
      }
      return;
    }

    if (values.length !== batch.keys.length) {
      const error = batchError(batch.keys.length, values.length);
      for (const cb of batch.callbacks) {
        for (const subscriber of cb.subscribers) subscriber.reject(error);
      }
      return;
    }

    for (let i = 0; i < batch.keys.length; i++) {
      const key = batch.keys[i] as Key;
      const value = values[i];
      const cb = batch.callbacks[i];
      const cacheKey = cacheKeyFn(key);

      if (value instanceof Error) {
        for (const subscriber of cb?.subscribers ?? []) subscriber.reject(value);
        continue;
      }

      cache?.set(cacheKey, value);
      for (const subscriber of cb?.subscribers ?? []) subscriber.resolve(value);
    }
  };

  const getCurrentBatch = (): Batch<Key, Value, CacheKey> => {
    if (currentBatch && !currentBatch.hasDispatched && currentBatch.keys.length < maxBatchSize) {
      return currentBatch;
    }

    const batch: Batch<Key, Value, CacheKey> = {
      hasDispatched: false,
      keys: [],
      keyIndices: new Map(),
      callbacks: [],
    };
    currentBatch = batch;
    batchScheduleFn(() => {
      void dispatch(batch);
    });
    return batch;
  };

  const load = (key: Key): Promise<Value> => {
    const cacheKey = cacheKeyFn(key);

    if (cache) {
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return Promise.resolve(cached);
    }

    const batch = getCurrentBatch();
    const existingIndex = batch.keyIndices.get(cacheKey);

    let batchIndex: number;
    if (existingIndex !== undefined) {
      batchIndex = existingIndex;
    } else {
      batchIndex = batch.keys.length;
      batch.keys.push(key);
      batch.keyIndices.set(cacheKey, batchIndex);
      batch.callbacks.push({ subscribers: [] });
    }

    return new Promise<Value>((resolve, reject) => {
      batch.callbacks[batchIndex]?.subscribers.push({ resolve, reject });
    });
  };

  const loadMany = (keys: readonly Key[]): Promise<readonly Value[]> =>
    Promise.all(keys.map((key) => load(key)));

  const api: DataLoader<Key, Value> = {
    load,
    loadMany,
    prime(key, value) {
      if (cache) cache.set(cacheKeyFn(key), value);
      return api;
    },
    clear(key) {
      if (cache) cache.delete(cacheKeyFn(key));
      return api;
    },
    clearAll() {
      cache?.clear();
      return api;
    },
  };

  return api;
};
