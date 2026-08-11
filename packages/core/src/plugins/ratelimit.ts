/**
 * @fileoverview Rate limit plugin — Bun 1.4 edition.
 *
 * Uses ctx.ip, which prefers Bun server.requestIP(). Optionally delegates the
 * per-key window state to the Rust addon's sharded fixed-window limiter
 * (`native: true`) — identical semantics (allow up to `maxRequests` per
 * window, then 429 until reset), with the fixed-window state machine in Rust.
 * Without the addon, `native: true` transparently falls back to a pure-TS
 * limiter with the same behavior.
 */

import { createRateLimiter } from "@flux/native";
import { LRUCache } from "../data/lru";
import type { FluxContext } from "../http/context";
import { reWrapResponse } from "../http/headers";
import type { FluxPlugin } from "../lifecycle/plugin";
import { firstForwardedIp } from "../platform/coerce";

export interface RateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
  storeMax?: number;
  trustProxy?: boolean;
  keyGenerator?: (ctx: FluxContext) => string;
  skip?: (ctx: FluxContext) => boolean;
  message?: string;
  /**
   * Use the native Rust rate limiter when the addon is present (default
   * `false`). Falls back to the TS implementation without the addon.
   */
  native?: boolean;
}

interface WindowEntry {
  count: number;
  resetTime: number;
}

/** Unified rate-limit state carried to `onResponse` for the headers. */
interface RateState {
  remaining: number;
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
    native = false,
  } = options;

  const defaultKeyGenerator = (ctx: FluxContext): string => {
    if (trustProxy) {
      const xff = ctx.headers.get("x-forwarded-for");

      if (xff) {
        return firstForwardedIp(xff) || ctx.ip;
      }
    }

    return ctx.ip;
  };

  const keyGenerator = options.keyGenerator ?? defaultKeyGenerator;

  // Native backend (opt-in). `createRateLimiter` is native when the addon is
  // present and otherwise returns a pure-TS fixed-window limiter with the same
  // semantics — so `native: true` never changes behavior, only the backend.
  const nativeLimiter = native
    ? createRateLimiter({ limit: maxRequests, windowMs, maxEntries: storeMax })
    : null;

  const store = nativeLimiter
    ? null
    : new LRUCache<string, WindowEntry>({
        max: storeMax,
        ttlMs: windowMs,
      });

  const getHeaders = (state: RateState): Record<string, string> => ({
    "X-RateLimit-Limit": String(maxRequests),
    "X-RateLimit-Remaining": String(Math.max(0, state.remaining)),
    "X-RateLimit-Reset": String(Math.ceil(state.resetTime / 1000)),
  });

  const limitResponse = (state: RateState): Response =>
    Response.json(
      { error: message },
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          ...getHeaders(state),
        },
      },
    );

  return {
    name: "rateLimit",

    onRequest(ctx) {
      if (skip?.(ctx)) return ctx;

      const key = keyGenerator(ctx);
      const now = Date.now();

      if (nativeLimiter) {
        const check = nativeLimiter.check(key, now);
        const state: RateState = { remaining: check.remaining, resetTime: check.resetMs };

        if (!check.allowed) return limitResponse(state);

        ctx.setState("__ratelimit", state);
        return ctx;
      }

      let entry = store!.get(key);

      if (!entry || entry.resetTime <= now) {
        entry = { count: 0, resetTime: now + windowMs };
        store!.set(key, entry, { ttlMs: windowMs });
      }

      entry.count++;

      store!.set(key, entry, {
        ttlMs: Math.max(0, entry.resetTime - now),
      });

      const state: RateState = { remaining: maxRequests - entry.count, resetTime: entry.resetTime };

      if (entry.count > maxRequests) {
        return limitResponse(state);
      }

      ctx.setState("__ratelimit", state);

      return ctx;
    },

    onResponse(ctx, response) {
      const state = ctx.getState<RateState>("__ratelimit");

      if (!state) return response;

      const headers = new Headers(response.headers);

      for (const [k, v] of Object.entries(getHeaders(state))) {
        headers.set(k, v);
      }

      return reWrapResponse(response, { headers });
    },
  };
};
