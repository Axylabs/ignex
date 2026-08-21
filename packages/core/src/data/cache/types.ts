/**
 * @fileoverview HTTP caching types — options, cached-entry shape, and parsed
 * Cache-Control directives.
 */

/** Options controlling a `Cache-Control` header value. */
export interface CacheControlOptions {
  maxAge?: number;
  sMaxAge?: number;
  swr?: number; // stale-while-revalidate seconds
  immutable?: boolean;
  noStore?: boolean;
  noCache?: boolean;
  public?: boolean;
  private?: boolean;
}

/** Options for browser-side caching (`withBrowserCache`). */
export interface BrowserCacheOptions extends CacheControlOptions {
  req?: Request;
  etag?: string;
  lastModified?: Date | string;
  vary?: string[];
}

/** Options for {@link HttpResponseCache}. */
export interface HttpResponseCacheOptions {
  max?: number;
  ttlMs?: number;
  staleTtlMs?: number;
  maxBytes?: number;
  maxBodyBytes?: number;
  /**
   * Pluggable backing store (default: an internal LRU). Implementing the
   * small {@link HttpResponseCacheStore} surface lets users swap the cache
   * backend (e.g. a shared sqlite/file/custom store) without changing cache
   * semantics — the Laravel-style cache driver story.
   */
  store?: HttpResponseCacheStore;
}

/**
 * The minimal backing-store surface used by {@link HttpResponseCache}.
 *
 * Sync-capable like the `data/store` drivers: `get`/`set` may return plain
 * values or Promises; the cache awaits when needed. Implementors may return
 * richer values than the declared minimal shape (e.g. an LRU returning `this`
 * from `set`) — only the listed members are consumed.
 */
export interface HttpResponseCacheStore {
  /** Read an entry, optionally allowing a stale (expired) value. */
  get(
    key: string,
    options?: { allowStale?: boolean },
  ): CachedHttpResponse | undefined | Promise<CachedHttpResponse | undefined>;
  /** Write an entry with freshness/staleness lifetimes. */
  set(
    key: string,
    value: CachedHttpResponse,
    options?: { ttlMs?: number; staleTtlMs?: number },
  ): unknown;
}

/** A stored, cacheable HTTP response entry. */
export interface CachedHttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
  etag?: string;
  /** Epoch ms when the entry was stored (drives staleness + revalidation). */
  storedAt: number;
  /** Effective freshness lifetime of this entry, in ms. */
  ttlMs: number;
}

/**
 * Parsed `Cache-Control` header directives. Presence flags are booleans;
 * numeric directives (`max-age`, …) are numbers when present.
 */
export interface CacheControlDirectives {
  noStore: boolean;
  noCache: boolean;
  mustRevalidate: boolean;
  proxyRevalidate: boolean;
  immutable: boolean;
  public: boolean;
  private: boolean;
  noTransform: boolean;
  onlyIfCached: boolean;
  maxAge?: number;
  sMaxAge?: number;
  staleWhileRevalidate?: number;
  staleIfError?: number;
}
