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
/** The batch function: maps a batch of keys to one value per key. */
export type BatchLoadFn<Key, Value> = (keys: readonly Key[]) => Promise<readonly Value[]>;

/** Options for {@link createDataLoader}. */
export interface DataLoaderOptions<Key, Value, CacheKey = Key> {
  /** Max keys per batch; flush immediately when reached. Default: Infinity. */
  maxBatchSize?: number;
  /** Cache instance, or `false` to disable caching. Default: `new Map()`. */
  cache?: Map<CacheKey, Value> | false;
  /** Map a key to a cache key. Default: identity. */
  cacheKeyFn?: (key: Key) => CacheKey;
  /** Schedule a batch dispatch. Default: `queueMicrotask`. */
  batchScheduleFn?: (callback: () => void) => void;
  /**
   * Cache per-key `Error` values so a consistently-failing key is NOT
   * re-batched on every request. Default `false` (standard DataLoader
   * semantics — errors are re-fetched so a transient failure can recover).
   * Enable for hot paths where a failing key would otherwise hammer the
   * batch function (e.g. a poisoned cache key). Cached errors are cleared by
   * {@link DataLoader.clear} / {@link DataLoader.clearAll} like any other
   * entry.
   */
  cacheErrors?: boolean;
}

/**
 * A DataLoader instance: batches concurrent loads, caches results, and
 * supports invalidation.
 */
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

/**
 * Create a DataLoader around a `batchLoadFn`.
 *
 * Concurrent `load(key)` calls within one microtask are batched into a single
 * `batchLoadFn(keys)` call; results are cached for the loader's lifetime
 * (per-request when created via `ctx.loader`) unless `cache: false`.
 *
 * @param batchLoadFn - Maps a batch of keys to one value per key.
 * @param options - Batching/caching tuning (see {@link DataLoaderOptions}).
 * @throws When `batchLoadFn` returns a mismatched number of values.
 */
export const createDataLoader = <Key, Value, CacheKey = Key>(
  batchLoadFn: BatchLoadFn<Key, Value>,
  options: DataLoaderOptions<Key, Value, CacheKey> = {},
): DataLoader<Key, Value> => {
  const maxBatchSize = options.maxBatchSize ?? Number.POSITIVE_INFINITY;
  const cache = options.cache === false ? null : (options.cache ?? new Map<CacheKey, Value>());
  const cacheKeyFn = options.cacheKeyFn ?? (identity as (key: Key) => CacheKey);
  const batchScheduleFn =
    options.batchScheduleFn ?? ((callback: () => void): void => queueMicrotask(callback));
  // Separate error cache (a rejected `Error` is not a `Value`). Keeps the
  // value cache type-clean and lets `cacheErrors` be independent of `cache`.
  const cacheErrors = options.cacheErrors ?? false;
  const errorCache: Map<CacheKey, Error> | null = cacheErrors ? new Map() : null;

  let currentBatch: Batch<Key, Value, CacheKey> | null = null;

  const rejectAll = (batch: Batch<Key, Value, CacheKey>, error: unknown): void => {
    for (const cb of batch.callbacks) {
      for (const subscriber of cb.subscribers) subscriber.reject(error);
    }
  };

  const settleKey = (key: Key, value: Value, cb: BatchCallback<Value> | undefined): void => {
    const cacheKey = cacheKeyFn(key);
    if (value instanceof Error) {
      // Standard DataLoader: a per-key Error rejects only that key and is
      // NOT cached. With `cacheErrors` we cache it so a repeat load rejects
      // from the error cache instead of re-batching (avoids hammering the
      // batch function for a permanently-failing key).
      if (errorCache) errorCache.set(cacheKey, value);
      for (const subscriber of cb?.subscribers ?? []) subscriber.reject(value);
      return;
    }
    cache?.set(cacheKey, value);
    for (const subscriber of cb?.subscribers ?? []) subscriber.resolve(value as Value);
  };

  const dispatch = async (batch: Batch<Key, Value, CacheKey>): Promise<void> => {
    batch.hasDispatched = true;
    if (batch.keys.length === 0) return;

    let values: readonly Value[];
    try {
      values = await batchLoadFn(batch.keys);
    } catch (error) {
      rejectAll(batch, error);
      return;
    }

    if (values.length !== batch.keys.length) {
      rejectAll(batch, batchError(batch.keys.length, values.length));
      return;
    }

    for (let i = 0; i < batch.keys.length; i++) {
      settleKey(batch.keys[i] as Key, values[i] as Value, batch.callbacks[i]);
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

    if (errorCache) {
      const cachedErr = errorCache.get(cacheKey);
      if (cachedErr) return Promise.reject(cachedErr);
    }

    if (cache) {
      // `has()` distinguishes a legitimately-`undefined` cached value from a
      // miss, so a batch result that resolves to `undefined` is cached and not
      // re-fetched on subsequent loads.
      if (cache.has(cacheKey)) return Promise.resolve(cache.get(cacheKey) as Value);
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
    // Standard DataLoader semantics: output order/duplicates mirror the input
    // array; concurrent duplicate keys still hit the per-batch dedup (each
    // unique key reaches batchLoadFn once per batch).
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
      errorCache?.delete(cacheKeyFn(key));
      return api;
    },
    clearAll() {
      cache?.clear();
      errorCache?.clear();
      // NOTE: an in-flight batch still resolves into the cache after a
      // clearAll (benign — the values were valid when fetched).
      return api;
    },
  };

  return api;
};
