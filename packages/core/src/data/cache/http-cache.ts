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
import { type ResponseCachePolicyOptions, responseCachePolicy } from "./response-policy";
import type { CachedHttpResponse, HttpResponseCacheOptions, HttpResponseCacheStore } from "./types";

function sanitizeHeaders(headers: Headers): [string, string][] {
  return Array.from(stripHopByHopHeaders(headers).entries());
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
 *
 * Requests carrying an `Authorization` header (or cookies, unless the caller
 * varies on `cookie`) bypass the cache entirely — see {@link HttpResponseCache.getOrSet}
 * options `allowAuthorized` / `allowCookies` for the explicit opt-outs.
 */
export class HttpResponseCache {
  private store: HttpResponseCacheStore;
  private maxBodyBytes: number;
  private defaultTtlMs: number;
  private onStoreError: "open" | "throw";
  private storeWarningEmitted = false;
  /** In-flight cache fills keyed by cache key — single-flight (thundering-herd) guard. */
  private inflight = new Map<string, Promise<Response>>();
  /** Keys currently being background-refreshed (stale-hit revalidation). */
  private refreshing = new Set<string>();

  constructor(opts: HttpResponseCacheOptions = {}) {
    this.maxBodyBytes = opts.maxBodyBytes ?? 1_048_576;
    this.defaultTtlMs = opts.ttlMs ?? 60_000;
    this.onStoreError = opts.onStoreError ?? "open";

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

  private handleStoreError(error: unknown): null {
    if (this.onStoreError === "throw") throw error;
    if (!this.storeWarningEmitted) {
      this.storeWarningEmitted = true;
      console.warn(
        "[ignex] response cache: backing store failed; bypassing cache (onStoreError: open)",
      );
    }
    return null;
  }

  private storedEntry(entry: CachedHttpResponse | undefined): StoredEntry | null {
    if (!entry) return null;
    const stale = Date.now() - entry.storedAt >= entry.ttlMs;
    if (stale && entry.mustRevalidate) return null;
    return { entry, stale };
  }

  /** Read once; only backing-store errors use the configured failure policy. */
  private readEntry(key: string): StoredEntry | Promise<StoredEntry | null> | null {
    let stored: ReturnType<HttpResponseCacheStore["get"]>;
    try {
      stored = this.store.get(key, { allowStale: true });
    } catch (error) {
      return this.handleStoreError(error);
    }
    return stored instanceof Promise
      ? stored.then(
          (entry) => this.storedEntry(entry),
          (error) => this.handleStoreError(error),
        )
      : this.storedEntry(stored);
  }

  async get(req: Request, key: string): Promise<Response | null> {
    const found = this.readEntry(key);
    const resolved = found instanceof Promise ? await found : found;
    if (!resolved) return null;

    return this.responseFromEntry(req, resolved.entry);
  }

  private responseFromEntry(req: Request, entry: CachedHttpResponse): Response {
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
    opts: ResponseCachePolicyOptions = {},
  ): Promise<Response> {
    const policy = responseCachePolicy(response, opts, this.defaultTtlMs);
    if (!policy) return response;

    const clone = response.clone();
    const reader = clone.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > this.maxBodyBytes) {
            // Cancelling a tee branch can wait for the caller's branch to finish.
            // Do not await it: the original response must remain consumable.
            void reader.cancel().catch(() => {});
            return response;
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = bytes.buffer;

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
      ttlMs: policy.ttlMs,
      ...(policy.mustRevalidate ? { mustRevalidate: true } : {}),
    };

    if (etag) {
      cached.etag = etag;
    }

    try {
      await this.store.set(key, cached, {
        ttlMs: policy.ttlMs,
        ...(policy.staleTtlMs !== undefined ? { staleTtlMs: policy.staleTtlMs } : {}),
      });
    } catch (error) {
      this.handleStoreError(error);
    }

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
      allowAuthorized?: boolean;
      allowCookies?: boolean;
    } = {},
  ): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return factory();
    }

    // RFC 9111 §3.5: a shared cache MUST NOT serve a stored response for a
    // request carrying Authorization unless explicitly allowed — the cache
    // key does not include credentials, so serving one would leak response
    // bodies across users. Cookie-bearing requests are bypassed too unless
    // the caller varies on `cookie` (per-cookie keys) or opts in, because
    // session-scoped output silently cross-poisones anonymous keys otherwise.
    if (!opts.allowAuthorized && req.headers.has("authorization")) {
      return factory();
    }
    if (
      !opts.allowCookies &&
      !opts.vary?.some((h) => h.toLowerCase() === "cookie") &&
      req.headers.has("cookie")
    ) {
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
    const found = this.readEntry(key);
    const resolved = found instanceof Promise ? await found : found;

    if (resolved) {
      const hit = this.responseFromEntry(req, resolved.entry);
      // Reuse the same entry for freshness and response construction: async
      // stores must not pay a second read on every cache hit.
      if (resolved.stale && !this.refreshing.has(key)) {
        this.startBackgroundRefresh(key, factory, opts);
      }
      return hit;
    }

    // Coalesce the origin work, not the consumable response. Waiters clone
    // during the fill promise's reactions, before the initiating caller can
    // consume the original. No store read-back or retained spare clone is needed.
    const inFlight = this.inflight.get(key);
    if (inFlight) return (await inFlight).clone();

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
    return await promise;
  }
}
