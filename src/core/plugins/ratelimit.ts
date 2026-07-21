/**
 * Rate limit plugin — Bun 1.4 edition.
 *
 * Uses ctx.ip, which prefers Bun server.requestIP().
 */

import type { FluxPlugin } from "../plugin";
import type { FluxContext } from "../context";
import { LRUCache } from "../lru";

export interface RateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
  storeMax?: number;
  trustProxy?: boolean;
  keyGenerator?: (ctx: FluxContext) => string;
  skip?: (ctx: FluxContext) => boolean;
  message?: string;
}

interface WindowEntry {
  count: number;
  resetTime: number;
}

export const rateLimit = (options: RateLimitOptions = {}): FluxPlugin => {
  const {
    windowMs = 60_000,
    maxRequests = 100,
    storeMax = 10_000,
    trustProxy = false,
    skip,
    message = "Too many requests",
  } = options;

  const defaultKeyGenerator = (ctx: FluxContext): string => {
    if (trustProxy) {
      const xff = ctx.headers.get("x-forwarded-for");

      if (xff) {
        return xff.split(",")[0]?.trim() || ctx.ip;
      }
    }

    return ctx.ip;
  };

  const keyGenerator = options.keyGenerator ?? defaultKeyGenerator;

  const store = new LRUCache<string, WindowEntry>({
    max: storeMax,
    ttlMs: windowMs,
  });

  const getHeaders = (entry: WindowEntry): Record<string, string> => ({
    "X-RateLimit-Limit": String(maxRequests),
    "X-RateLimit-Remaining": String(Math.max(0, maxRequests - entry.count)),
    "X-RateLimit-Reset": String(Math.ceil(entry.resetTime / 1000)),
  });

  return {
    name: "rateLimit",

    onRequest(ctx) {
      if (skip?.(ctx)) return ctx;

      const key = keyGenerator(ctx);
      const now = Date.now();

      let entry = store.get(key);

      if (!entry || entry.resetTime <= now) {
        entry = { count: 0, resetTime: now + windowMs };
        store.set(key, entry, { ttlMs: windowMs });
      }

      entry.count++;

      store.set(key, entry, {
        ttlMs: Math.max(0, entry.resetTime - now),
      });

      if (entry.count > maxRequests) {
        return Response.json(
          { error: message },
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              ...getHeaders(entry),
            },
          }
        );
      }

      ctx.setState("__ratelimit", entry);

      return ctx;
    },

    onResponse(ctx, response) {
      const entry = ctx.getState<WindowEntry>("__ratelimit");

      if (!entry) return response;

      const headers = new Headers(response.headers);

      for (const [k, v] of Object.entries(getHeaders(entry))) {
        headers.set(k, v);
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
};
