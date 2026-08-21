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

import { createRateLimiter } from "@ignex/native";
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
import type { IgnexContext } from "../http/context";
import { reWrapResponse } from "../http/headers";
import type { IgnexPlugin } from "../lifecycle/plugin";
import { firstForwardedIp } from "../platform/coerce";

/** One-time warning when IP detection is unavailable (see onRequest below). */
let anonymousWarned = false;
const warnAnonymousKeyOnce = (): void => {
  if (anonymousWarned) return;
  anonymousWarned = true;
  console.warn(
    '[ignex] rateLimit: request IP is unavailable (no `server.requestIP` and `trustProxy: false`) — every request keys as "anonymous" and would share ONE bucket, so the limit is being skipped. Enable `trustProxy: true` (or pass a `keyGenerator`) to key per client.',
  );
};

/**
 * A pluggable rate-limit state store — the per-key window/token state.
 *
 * The default is an in-process LRU; pass a shared store (e.g. a sqlite/file
 * `data/store` driver or a custom distributed store) to share limits across
 * instances. Sync-capable like the store drivers: `get`/`set` may return
 * plain values or Promises — the plugin branches on `instanceof Promise`.
 */
export interface RateLimitStore {
  /** Read the persisted state for a key (or `undefined` when absent/expired). */
  get(
    key: string,
  ):
    | FixedWindowEntry
    | SlidingWindowEntry
    | TokenBucketEntry
    | undefined
    | Promise<FixedWindowEntry | SlidingWindowEntry | TokenBucketEntry | undefined>;
  /** Persist the next state for a key with a TTL. */
  set(
    key: string,
    state: FixedWindowEntry | SlidingWindowEntry | TokenBucketEntry,
    options?: { ttlMs?: number },
  ): void | Promise<void>;
}

/** Options for {@link rateLimit}. */
export interface RateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
  storeMax?: number;
  trustProxy?: boolean;
  keyGenerator?: (ctx: IgnexContext) => string;
  skip?: (ctx: IgnexContext) => boolean;
  message?: string;
  /**
   * Limiting algorithm. `fixed-window` (default) is the classic reset-per-
   * window; `sliding-window` smooths it with a weighted previous window;
   * `token-bucket` allows bursts up to `maxRequests` and refills continuously.
   */
  algorithm?: RateLimitAlgorithm;
  /**
   * Pluggable state store (default: an LRU bounded by `storeMax`). Pass a
   * shared driver to make limits stick across processes.
   */
  store?: RateLimitStore;
  /**
   * Use the native Rust rate limiter when the addon is present (default
   * `false`). The native backend is fixed-window only; other algorithms use
   * the TS state machines. Falls back to the TS implementation without the
   * addon. Ignored when `store` is provided (a custom store implies the TS
   * state machines).
   */
  native?: boolean;
}

/** Unified rate-limit state carried to `onResponse` for the headers. */
interface RateState {
  allowed: boolean;
  remaining: number;
  resetTime: number;
}

/**
 * Rate limit plugin — per-IP window (optionally Rust-accelerated).
 *
 * @param options - Window/limit tuning, algorithm, key generator, skip.
 * @returns The rate-limit plugin.
 */
export const rateLimit = (options: RateLimitOptions = {}): IgnexPlugin => {
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

  const defaultKeyGenerator = (ctx: IgnexContext): string => {
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
  // A custom `store` implies the TS state machines (native ignores it).
  const nativeLimiter =
    native && !options.store
      ? createRateLimiter({ limit: maxRequests, windowMs, maxEntries: storeMax })
      : null;

  const store =
    options.store ??
    (nativeLimiter
      ? null
      : new LRUCache<string, FixedWindowEntry | SlidingWindowEntry | TokenBucketEntry>({
          max: storeMax,
          ttlMs: windowMs,
        }));

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

  /** Run one TS state-machine check for the algorithm and persist the next state. */
  const checkWithStore = (
    key: string,
    stored: FixedWindowEntry | SlidingWindowEntry | TokenBucketEntry | undefined,
    now: number,
  ): RateState => {
    const config = { windowMs, maxRequests };

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

    store?.set(key, decision.state, { ttlMs: Math.max(0, decision.resetMs - now) });

    return {
      allowed: decision.allowed,
      remaining: decision.remaining,
      resetTime: decision.resetMs,
    };
  };

  /** Finish an onRequest: 429 when the budget is exhausted, else record + pass. */
  const finishCheck = (ctx: IgnexContext, state: RateState): IgnexContext | Response => {
    if (!state.allowed) return limitResponse(state);
    ctx.setState("__ratelimit", state);
    return ctx;
  };

  return {
    name: "rateLimit",

    onRequest(ctx): IgnexContext | Response | Promise<IgnexContext | Response> {
      if (skip?.(ctx)) return ctx;

      const key = keyGenerator(ctx);
      const now = Date.now();

      // IP detection unavailable (no `server.requestIP` and `trustProxy:
      // false`, e.g. behind a reverse proxy): the DEFAULT key resolves to
      // "anonymous" for every client, so they would ALL share one bucket —
      // a single actor could exhaust the budget for everyone. Warn loudly
      // (once) so the operator enables `trustProxy: true` (or passes a
      // `keyGenerator`); the limiter itself keeps its documented semantics.
      if (key === "anonymous" && keyGenerator === defaultKeyGenerator) {
        warnAnonymousKeyOnce();
      }

      if (nativeLimiter) {
        const check = nativeLimiter.check(key, now);
        const state: RateState = {
          allowed: check.allowed,
          remaining: check.remaining,
          resetTime: check.resetMs,
        };

        if (!check.allowed) return limitResponse(state);

        ctx.setState("__ratelimit", state);
        return ctx;
      }

      const stored = store?.get(key);
      if (stored instanceof Promise) {
        // Async store (e.g. a shared sqlite/file/custom driver): resolve the
        // state, run the check, then decide — the plugin returns a Promise.
        return stored.then((value) => finishCheck(ctx, checkWithStore(key, value, now)));
      }

      return finishCheck(ctx, checkWithStore(key, stored, now));
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
