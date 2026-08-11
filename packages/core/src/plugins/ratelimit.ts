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

import { createRateLimiter } from "@ignus/native";
import { LRUCache } from "../data/lru";
import {
  checkFixedWindow,
  checkSlidingWindow,
  checkTokenBucket,
  type FixedWindowEntry,
  freshFixedWindow,
  freshSlidingWindow,
  freshTokenBucket,
  type RateDecision,
  type RateLimitAlgorithm,
  type SlidingWindowEntry,
  type TokenBucketEntry,
} from "../data/ratelimit";
import type { IgnusContext } from "../http/context";
import { reWrapResponse } from "../http/headers";
import type { IgnusPlugin } from "../lifecycle/plugin";
import { firstForwardedIp } from "../platform/coerce";

export interface RateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
  storeMax?: number;
  trustProxy?: boolean;
  keyGenerator?: (ctx: IgnusContext) => string;
  skip?: (ctx: IgnusContext) => boolean;
  message?: string;
  /**
   * Limiting algorithm. `fixed-window` (default) is the classic reset-per-
   * window; `sliding-window` smooths it with a weighted previous window;
   * `token-bucket` allows bursts up to `maxRequests` and refills continuously.
   */
  algorithm?: RateLimitAlgorithm;
  /**
   * Use the native Rust rate limiter when the addon is present (default
   * `false`). The native backend is fixed-window only; other algorithms use
   * the TS state machines. Falls back to the TS implementation without the
   * addon.
   */
  native?: boolean;
}

interface RateState {
  remaining: number;
  resetTime: number;
}

/** Unified rate-limit state carried to `onResponse` for the headers. */
interface RateState {
  remaining: number;
  resetTime: number;
}

export const rateLimit = (options: RateLimitOptions = {}): IgnusPlugin => {
  const {
    windowMs = 60_000,
    maxRequests = 100,
    storeMax = 10_000,
    trustProxy = false,
    skip,
    message = "Too many requests",
    algorithm = "fixed-window",
    native = false,
  } = options;

  const defaultKeyGenerator = (ctx: IgnusContext): string => {
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
    : new LRUCache<string, FixedWindowEntry | SlidingWindowEntry | TokenBucketEntry>({
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

      const config = { windowMs, maxRequests };
      const stored = store!.get(key);

      let decision: RateDecision;

      if (algorithm === "sliding-window") {
        const base = (stored as SlidingWindowEntry | undefined) ?? freshSlidingWindow(now);
        decision = checkSlidingWindow(config, base, now);
      } else if (algorithm === "token-bucket") {
        const base = (stored as TokenBucketEntry | undefined) ?? freshTokenBucket(now, maxRequests);
        decision = checkTokenBucket(config, base, now);
      } else {
        const base = (stored as FixedWindowEntry | undefined) ?? freshFixedWindow(now, windowMs);
        decision = checkFixedWindow(config, base, now);
      }

      store!.set(key, decision.state, { ttlMs: Math.max(0, decision.resetMs - now) });

      const state: RateState = { remaining: decision.remaining, resetTime: decision.resetMs };

      if (!decision.allowed) return limitResponse(state);

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
