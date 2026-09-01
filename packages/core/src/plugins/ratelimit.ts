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
import { lastForwardedIp } from "../platform/coerce";

/** One-time warning when IP detection is unavailable (see onRequest below). */
let anonymousWarned = false;
const warnAnonymousKeyOnce = (): void => {
  if (anonymousWarned) return;
  anonymousWarned = true;
  console.warn(
    '[ignex] rateLimit: request IP is unavailable (no `server.requestIP` and `trustProxy: false`) — every client keys as the single shared bucket "anonymous", so ONE actor can exhaust everyone\'s budget. Enable `trustProxy: true` (or pass a `keyGenerator`) to key per client.',
  );
};

/**
 * A pluggable rate-limit state store — the per-key window/token state.
 *
 * The default is an in-process LRU; pass a shared store (e.g. a sqlite/file
 * `data/store` driver or a custom distributed store) to share limits across
 * instances. Sync-capable like the store drivers: `get`/`set` may return
 * plain values or Promises — the plugin branches on `instanceof Promise`.
 *
 * ATOMIC shared counting: the read→compute→write flow below is non-atomic —
 * N replicas sharing one store drift toward `N × maxRequests`. When the store
 * exposes an atomic fixed-window `incr` (see `createRedisRateLimitStore`),
 * the plugin uses it INSTEAD for `algorithm: "fixed-window"`, making the
 * count authoritative across all replicas.
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
  /**
   * ATOMIC fixed-window increment (optional capability). Implementations
   * increment the shared counter and start the window TTL on first hit —
   * no read-then-write race. Present on `createRedisRateLimitStore()`.
   */
  incr?(key: string, windowMs: number, now: number): Promise<FixedWindowEntry>;
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
  /**
   * Policy when the shared store ERRORS (Redis down, sqlite locked, …).
   * `"open"` (default): log once and ALLOW — availability over strictness.
   * `"closed"`: reject with 503 — a broken shared limiter must not silently
   * disable protection. (Previously store errors produced unhandled promise
   * rejections with no policy at all.)
   */
  onStoreError?: "open" | "closed";
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
    onStoreError = "open",
  } = options;

  const defaultKeyGenerator = (ctx: IgnexContext): string => {
    if (trustProxy) {
      // Rightmost entry: appended by the trusted proxy, so a client cannot
      // rotate it per request (the leftmost entry is fully spoofable).
      const xff = ctx.headers.get("x-forwarded-for");

      if (xff) {
        return lastForwardedIp(xff) || ctx.ip;
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

    const persist = store?.set(key, decision.state, {
      ttlMs: Math.max(0, decision.resetMs - now),
    });
    if (persist instanceof Promise) {
      // A failed persistence must not reject into the request path — the
      // decision for THIS request is already computed; log once so operators
      // see a degraded limiter.
      persist.catch((err) => void storeErrorPolicy(err));
    }

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

  /** One-time store-error warning (the chosen policy must be visible). */
  let storeErrorWarned = false;
  /**
   * Apply the onStoreError policy: returns the 503 Response under
   * `"closed"`, or `null` to fail open. Never throws.
   */
  const storeErrorPolicy = (err: unknown): Response | null => {
    if (!storeErrorWarned) {
      storeErrorWarned = true;
      console.error(
        `[ignex] rateLimit: shared store failed — applying onStoreError:"${onStoreError}" ` +
          `policy (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (onStoreError === "closed") {
      return new Response(JSON.stringify({ error: "Service temporarily unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "1" },
      });
    }
    return null;
  };

  const handleStoreError = (ctx: IgnexContext, err: unknown): IgnexContext | Response =>
    storeErrorPolicy(err) ?? ctx;

  /** ATOMIC fixed-window check via a store that exposes `incr`. */
  const checkAtomic = async (key: string, now: number): Promise<RateState> => {
    // `store.incr` is guaranteed present on this path (guarded by caller).
    const entry = await (store as Required<Pick<RateLimitStore, "incr">>).incr(key, windowMs, now);
    return {
      allowed: entry.count <= maxRequests,
      remaining: Math.max(0, maxRequests - entry.count),
      resetTime: entry.resetTime,
    };
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

      // ATOMIC shared counting: when the store exposes `incr` (Redis et al.)
      // and the algorithm is fixed-window, skip the racy read→compute→write
      // and use the authoritative atomic increment.
      const incr = (store as RateLimitStore | null)?.incr;
      if (store && typeof incr === "function" && algorithm === "fixed-window") {
        return Promise.resolve()
          .then(() => checkAtomic(key, now))
          .then((state) => finishCheck(ctx, state))
          .catch((err) => handleStoreError(ctx, err));
      }

      let stored: ReturnType<NonNullable<RateLimitOptions["store"]>["get"]> | undefined;
      try {
        stored = store?.get(key);
      } catch (err) {
        return handleStoreError(ctx, err);
      }
      if (stored instanceof Promise) {
        // Async store (e.g. a shared sqlite/file/custom driver): resolve the
        // state, run the check, then decide — the plugin returns a Promise.
        // Store errors now hit the policy instead of becoming unhandled
        // rejections.
        return stored
          .then((value) => finishCheck(ctx, checkWithStore(key, value, now)))
          .catch((err) => handleStoreError(ctx, err));
      }

      try {
        return finishCheck(ctx, checkWithStore(key, stored, now));
      } catch (err) {
        return handleStoreError(ctx, err);
      }
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
