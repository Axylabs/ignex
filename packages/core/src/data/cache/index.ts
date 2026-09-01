/**
 * @fileoverview `data/cache` — HTTP caching primitives.
 *
 * Modules: types, cache-control, hash, browser, http-cache. The folder layout
 * is an internal implementation detail; consumers import `../data/cache`
 * (resolves to this barrel).
 */

export { withBrowserCache } from "./browser";
export { cacheControl, parseCacheControl } from "./cache-control";
export { entityTag } from "./hash";
export { HttpResponseCache } from "./http-cache";
export type {
  HttpResponseCacheOptions,
  HttpResponseCacheStore,
} from "./types";
