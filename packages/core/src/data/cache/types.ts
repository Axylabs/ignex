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
