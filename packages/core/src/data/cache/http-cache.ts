/**
 * @fileoverview HTTP response cache with a pluggable backing store, single-
 * flight cold misses and stale-while-revalidate background refresh.
 *
 * The default backing store is an LRU (memory); pass a custom
 * {@link HttpResponseCacheStore} (e.g. a sqlite/file/custom `data/store`
 * driver) to change where entries live — the Laravel-style cache driver story.
 */

import { isNotModified } from "../../http/conditional";
import { stripHopByHopHeaders } from "../../http/headers";
import { LRUCache } from "../lru";
import { parseCacheControl } from "./cache-control";
import { entityTag } from "./hash";
import type { CachedHttpResponse, HttpResponseCacheOptions, HttpResponseCacheStore } from "./types";

function sanitizeHeaders(headers: Headers): [string, string][] {
  return Array.from(stripHopByHopHeaders(headers).entries());
}

function isCacheableResponse(response: Response): boolean {
  if (response.headers.has("set-cookie")) return false;

  const cc = response.headers.get("cache-control") || "";
  if (cc.includes("no-store")) return false;
  if (cc.includes("private")) return false;

  return [200, 203, 204, 300, 301, 404, 410].includes(response.status);
}

interface StoredEntry {
  entry: CachedHttpResponse;
  /** True when the entry is older than its freshness lifetime. */
  stale: boolean;
}

/**
 * An HTTP response cache with a pluggable backing store, single-flight cold
 * misses and stale-while-revalidate background refresh.
 *
 * Only cacheable responses (per `Cache-Control`/`Set-Cookie` rules) are
 * stored; oversized bodies are rejected. `getOrSet` de-duplicates concurrent
 * misses for the same key.
 */
export class HttpResponseCache {
  private store: HttpResponseCacheStore;
  private maxBodyBytes: number;
  private defaultTtlMs: number;
  /** In-flight factories keyed by cache key — single-flight (thundering-herd) guard. */
  private inflight = new Map<string, Promise<Response>>();
  /** Keys currently being background-refreshed (stale-hit revalidation). */
  private refreshing = new Set<string>();

  constructor(opts: HttpResponseCacheOptions = {}) {
    this.maxBodyBytes = opts.maxBodyBytes ?? 1_048_576;
    this.defaultTtlMs = opts.ttlMs ?? 60_000;

    this.store =
      opts.store ??
      new LRUCache<string, CachedHttpResponse>({
        max: opts.max ?? 1000,
        ttlMs: this.defaultTtlMs,
        staleTtlMs: opts.staleTtlMs ?? 300_000,
        maxBytes: opts.maxBytes ?? 64 * 1024 * 1024,
        sizeOf: (v) => (v.body?.byteLength ?? 0) + 512,
      });
  }

  key(req: Request, vary: string[] = []): string {
    const url = new URL(req.url);

    const varyKey = vary.map((h) => `${h.toLowerCase()}=${req.headers.get(h) ?? ""}`).join("|");

    return `${req.method}:${url.pathname}${url.search}:${varyKey}`;
  }

  /** Read the stored entry (stale allowed) with a staleness flag. */
  private readEntry(key: string): StoredEntry | Promise<StoredEntry | null> | null {
    const stored = this.store.get(key, { allowStale: true });
    if (stored instanceof Promise) {
      // Async backing store: resolve, then compute staleness.
      return stored.then((entry) =>
        entry ? { entry, stale: Date.now() - entry.storedAt > entry.ttlMs } : null,
      );
    }
    if (!stored) return null;

    return {
      entry: stored,
      stale: Date.now() - stored.storedAt > stored.ttlMs,
    };
  }

  async get(req: Request, key: string): Promise<Response | null> {
    const found = this.readEntry(key);
    const resolved = found instanceof Promise ? await found : found;
    if (!resolved) return null;

    const { entry } = resolved;

    if (isNotModified(req, entry.etag)) {
      return new Response(null, {
        status: 304,
        headers: entry.headers,
      });
    }

    const headers = new Headers(entry.headers);
    headers.set("x-cache", "hit");

    return new Response(entry.body ? entry.body.slice(0) : null, {
      status: entry.status,
      statusText: entry.statusText,
      headers,
    });
  }

  async set(
    key: string,
    response: Response,
    opts: { ttlMs?: number; staleTtlMs?: number; etag?: boolean } = {},
  ): Promise<Response> {
    if (!isCacheableResponse(response)) return response;

    const clone = response.clone();
    const body = await clone.arrayBuffer();

    if (body.byteLength > this.maxBodyBytes) {
      return response;
    }

    const headers = sanitizeHeaders(response.headers);
    const etag = opts.etag === false ? undefined : entityTag(body);

    if (etag) {
      headers.push(["etag", etag]);
    }

    const cached: CachedHttpResponse = {
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
      storedAt: Date.now(),
      ttlMs: opts.ttlMs ?? this.defaultTtlMs,
    };

    if (etag) {
      cached.etag = etag;
    }

    await this.store.set(key, cached, {
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      ...(opts.staleTtlMs !== undefined ? { staleTtlMs: opts.staleTtlMs } : {}),
    });

    return response;
  }

  /**
   * Fire-and-forget refresh of a stale entry. Failures keep the stale entry
   * (a later request retries); the `refreshing` set prevents stampedes.
   */
  private startBackgroundRefresh(
    key: string,
    factory: () => Promise<Response>,
    opts: Parameters<HttpResponseCache["getOrSet"]>[2],
  ): void {
    this.refreshing.add(key);

    void (async () => {
      try {
        const response = await factory();
        await this.set(key, response, opts);
      } catch {
        // Keep the stale entry; a later request will retry.
      } finally {
        this.refreshing.delete(key);
      }
    })();
  }

  async getOrSet(
    req: Request,
    factory: () => Promise<Response>,
    opts: {
      ttlMs?: number;
      staleTtlMs?: number;
      vary?: string[];
      etag?: boolean;
    } = {},
  ): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return factory();
    }

    const directives = parseCacheControl(req.headers.get("cache-control") || "");
    if (directives.noStore || directives.noCache) {
      // `no-cache` means "don't serve a stored response without revalidation";
      // without a revalidation path to the origin, the safe equivalent is to
      // bypass the cache and fetch fresh.
      return factory();
    }

    const key = this.key(req, opts.vary);
    const hit = await this.get(req, key);

    if (hit) {
      // Serve the hit; when it's stale, refresh in the background so the next
      // request gets fresh data without paying the origin latency now.
      const found = this.readEntry(key);
      const resolved = found instanceof Promise ? await found : found;
      if (resolved?.stale && !this.refreshing.has(key)) {
        this.startBackgroundRefresh(key, factory, opts);
      }
      return hit;
    }

    // Single-flight: coalesce concurrent cold misses on the same key so the
    // origin is hit once. Concurrent callers await the same in-flight factory
    // instead of each re-fetching (thundering-herd protection).
    const inFlight = this.inflight.get(key);
    if (inFlight) return inFlight;

    const promise = (async () => {
      try {
        const response = await factory();
        await this.set(key, response, opts);
        return response;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }
}
