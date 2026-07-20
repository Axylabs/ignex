/**
 * @fileoverview Rate Limit Plugin — memory-backed, LRU-based.
 */

import type { FluxPlugin } from "../plugin";
import type { FluxContext } from "../context";
import { LRUCache } from "../lru";

export interface RateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
  storeMax?: number;
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
    keyGenerator = (ctx) =>
      ctx.headers.get("x-forwarded-for") ||
      ctx.headers.get("x-real-ip") ||
      "anonymous",
    skip,
    message = "Too many requests",
  } = options;

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

      if (entry) {
        for (const [k, v] of Object.entries(getHeaders(entry))) {
          response.headers.set(k, v);
        }
      }

      return response;
    },
  };
};