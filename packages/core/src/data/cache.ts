/**
 * @fileoverview HTTP caching primitives:
 * - Cache-Control builder
 * - ETag generation
 * - mtime-based cache bursting
 * - browser conditional requests
 * - LRU-backed HTTP response cache
 */

import { fnv1a64 } from "@flux/native";
import { isNotModified } from "../http/conditional";
import { HOP_BY_HOP_HEADERS, reWrapResponse } from "../http/headers";
import { LRUCache } from "./lru";

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

export interface BrowserCacheOptions extends CacheControlOptions {
  req?: Request;
  etag?: string;
  lastModified?: Date | string;
  vary?: string[];
}

export function cacheControl(opts: CacheControlOptions = {}): string {
  if (opts.noStore) return "no-store";
  if (opts.noCache) return "no-cache";

  const parts: string[] = [];

  if (opts.public) parts.push("public");
  if (opts.private) parts.push("private");

  if (opts.maxAge != null) {
    parts.push(`max-age=${Math.max(0, Math.floor(opts.maxAge))}`);
  }

  if (opts.swr != null) {
    parts.push(`stale-while-revalidate=${Math.max(0, Math.floor(opts.swr))}`);
  }

  if (opts.sMaxAge != null) {
    parts.push(`s-maxage=${Math.max(0, Math.floor(opts.sMaxAge))}`);
  }

  if (opts.immutable) parts.push("immutable");

  return parts.length > 0 ? parts.join(", ") : "no-cache";
}

function toBytes(input: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input);
}

/**
 * Fast non-cryptographic hash for cache keys and weak ETags.
 * Prefers the Rust addon's FNV-1a 64 (proven ~11x faster than JS), with a
 * pure-TS fallback inside `@flux/native` — so results are deterministic
 * whether or not the addon is present.
 */
export function fastHash(input: string | ArrayBuffer | Uint8Array): string {
  return fnv1a64(toBytes(input)).toString(36);
}

export function entityTag(body: string | ArrayBuffer | Uint8Array, weak = true): string {
  return `${weak ? "W/" : ""}"${fastHash(body)}"`;
}

/**
 * Apply browser cache headers and handle conditional requests.
 */
export function withBrowserCache(response: Response, opts: BrowserCacheOptions = {}): Response {
  const headers = new Headers(response.headers);

  if (opts.etag) headers.set("etag", opts.etag);

  const lastModified =
    opts.lastModified instanceof Date ? opts.lastModified.toUTCString() : opts.lastModified;

  if (lastModified) headers.set("last-modified", lastModified);

  if (!headers.has("cache-control")) {
    headers.set("cache-control", cacheControl(opts));
  }

  if (opts.vary?.length) {
    headers.set("vary", opts.vary.join(", "));
  }

  if (opts.req && response.status !== 304 && isNotModified(opts.req, opts.etag, lastModified)) {
    return new Response(null, { status: 304, headers });
  }

  return reWrapResponse(response, { headers });
}

// ---------------------------------------------------------------------------
// HTTP response cache
// ---------------------------------------------------------------------------

export interface HttpResponseCacheOptions {
  max?: number;
  ttlMs?: number;
  staleTtlMs?: number;
  maxBytes?: number;
  maxBodyBytes?: number;
}

export interface CachedHttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
  etag?: string;
}

function sanitizeHeaders(headers: Headers): [string, string][] {
  const out: [string, string][] = [];

  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lower)) {
      out.push([key, value]);
    }
  });

  return out;
}

function isCacheableResponse(response: Response): boolean {
  if (response.headers.has("set-cookie")) return false;

  const cc = response.headers.get("cache-control") || "";
  if (cc.includes("no-store")) return false;
  if (cc.includes("private")) return false;

  return [200, 203, 204, 300, 301, 404, 410].includes(response.status);
}

export class HttpResponseCache {
  private lru: LRUCache<string, CachedHttpResponse>;
  private maxBodyBytes: number;

  constructor(opts: HttpResponseCacheOptions = {}) {
    this.maxBodyBytes = opts.maxBodyBytes ?? 1_048_576;

    this.lru = new LRUCache({
      max: opts.max ?? 1000,
      ttlMs: opts.ttlMs ?? 60_000,
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

  async get(req: Request, key: string): Promise<Response | null> {
    const stored = this.lru.get(key, { allowStale: true });
    if (!stored) return null;

    if (isNotModified(req, stored.etag)) {
      return new Response(null, {
        status: 304,
        headers: stored.headers,
      });
    }

    const headers = new Headers(stored.headers);
    headers.set("x-cache", "hit");

    return new Response(stored.body ? stored.body.slice(0) : null, {
      status: stored.status,
      statusText: stored.statusText,
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
    };

    if (etag) {
      cached.etag = etag;
    }

    this.lru.set(key, cached, {
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      ...(opts.staleTtlMs !== undefined ? { staleTtlMs: opts.staleTtlMs } : {}),
    });

    return response;
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

    const reqCc = req.headers.get("cache-control") || "";
    if (reqCc.includes("no-store")) {
      return factory();
    }

    const key = this.key(req, opts.vary);
    const hit = await this.get(req, key);

    if (hit) return hit;

    const response = await factory();
    return this.set(key, response, opts);
  }
}
