/**
 * @fileoverview Cache-Control — the directive builder (`cacheControl`) and the
 * inverse parser (`parseCacheControl`).
 */

import type { CacheControlDirectives, CacheControlOptions } from "./types";

/**
 * Build a `Cache-Control` header value from options.
 *
 * `noStore`/`noCache` short-circuit; other directives are emitted when set,
 * with negative values clamped to 0.
 *
 * @param opts - The directives to emit.
 * @returns The `Cache-Control` header value.
 */
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

const emptyDirectives = (): CacheControlDirectives => ({
  noStore: false,
  noCache: false,
  mustRevalidate: false,
  proxyRevalidate: false,
  immutable: false,
  public: false,
  private: false,
  noTransform: false,
  onlyIfCached: false,
});

/**
 * Parse a `Cache-Control` header into structured directives. Directives are
 * comma-separated, case-insensitive, and may carry a value (`max-age=60`) or
 * be bare (`no-store`). Unknown directives are ignored; malformed numeric
 * values are dropped.
 */
export const parseCacheControl = (header: string): CacheControlDirectives => {
  const out = emptyDirectives();

  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? undefined : part.slice(eq + 1);
    const key = rawKey.trim().toLowerCase();
    const value = rawValue?.trim();

    const numeric = (): number | undefined => {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    };

    switch (key) {
      case "no-store":
        out.noStore = true;
        break;
      case "no-cache":
        out.noCache = true;
        break;
      case "must-revalidate":
        out.mustRevalidate = true;
        break;
      case "proxy-revalidate":
        out.proxyRevalidate = true;
        break;
      case "immutable":
        out.immutable = true;
        break;
      case "public":
        out.public = true;
        break;
      case "private":
        out.private = true;
        break;
      case "no-transform":
        out.noTransform = true;
        break;
      case "only-if-cached":
        out.onlyIfCached = true;
        break;
      case "max-age": {
        const n = numeric();
        if (n !== undefined) out.maxAge = n;
        break;
      }
      case "s-maxage": {
        const n = numeric();
        if (n !== undefined) out.sMaxAge = n;
        break;
      }
      case "stale-while-revalidate": {
        const n = numeric();
        if (n !== undefined) out.staleWhileRevalidate = n;
        break;
      }
      case "stale-if-error": {
        const n = numeric();
        if (n !== undefined) out.staleIfError = n;
        break;
      }
      default:
        break;
    }
  }

  return out;
};
