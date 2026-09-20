/**
 * @fileoverview Public sub-barrel: data (cache, content-encoding, dataloader,
 * drivers, lru, query, ratelimit, request, schema, store) re-exported from the
 * `@ignex/core` entry (split from the barrel `src/index.ts` by section banner —
 * move-only; `export` statements verbatim).
 */

// The cache-surface types precede the data banner in the source barrel — kept
// first here to preserve order.
export type {
  HttpResponseCacheOptions,
  HttpResponseCacheStore,
} from "../data/cache";
// ── data ────────────────────────────────────────────────────────
export {
  cacheControl,
  entityTag,
  HttpResponseCache,
  parseCacheControl,
  withBrowserCache,
} from "../data/cache";
export { etagWithEncoding, isCompressible, negotiateEncoding } from "../data/content-encoding";
export type {
  BatchLoadFn,
  DataLoader,
  DataLoaderFactory,
  DataLoaderOptions,
} from "../data/dataloader";
export { createDataLoader } from "../data/dataloader";
export {
  createDriverManager,
  type DriverFactory,
  type DriverManager,
  type DriverManagerOptions,
} from "../data/drivers/manager";
export { LRUCache } from "../data/lru";
export {
  groupQueryPairs,
  NativeQueryParams,
  parseQuery,
  parseQueryFromURL,
} from "../data/query";
export type { RateLimitAlgorithm } from "../data/ratelimit";
export {
  type DefinedRequest,
  defineRequest,
  type RequestOptions,
  type RequestPart,
  ValidationForbiddenError,
} from "../data/request";
export { compileValidator, validateAsync, validateOrThrow } from "../data/schema";
export {
  createFileStore,
  createMemoryStore,
  createRedisRateLimitStore,
  createRedisStore,
  createSqliteStore,
  createStoreManager,
  type FileStoreOptions,
  type MaybePromise,
  type MemoryStoreOptions,
  type RedisRateLimitStore,
  type RedisRateLimitStoreOptions,
  type RedisStoreOptions,
  redisMissingError,
  redisRateLimitMissingError,
  type SqliteStoreOptions,
  type Store,
  type StoreManagerOptions,
  type StoreSetOptions,
} from "../data/store";
