/**
 * Rate limiting — native-accelerated where proven.
 *
 * The Rust addon ships a sharded fixed-window per-key limiter (the same
 * engine the ingress pipeline uses). This module exposes it as a standalone
 * `RateLimiter` (per-instance budget) with a pure-TS fixed-window fallback, so
 * apps get native per-key rate limiting without mounting the full ingress
 * pipeline. Behavior parity is the contract (allow up to `limit` per window,
 * then deny until reset); exact `resetMs` math may differ between the native
 * weighted-overlap engine and the simple TS fallback.
 */
import { getNative } from "./loader";

const native = getNative();

export interface RateLimiterOptions {
  /** Max requests allowed per window per key. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Approximate max tracked keys (fallback only; native clamps internally). */
  maxEntries?: number;
}

export interface RateCheck {
  /** Whether the request is allowed. */
  readonly allowed: boolean;
  /** Remaining requests in the current window (saturating). */
  readonly remaining: number;
  /** Unix milliseconds when the window resets. */
  readonly resetMs: number;
}

export interface RateLimiter {
  /** Check a key at `nowMs` (defaults to `Date.now()`). */
  check(key: string, nowMs?: number): RateCheck;
}

/**
 * Create a rate limiter. Native-backed when the addon is available; otherwise
 * a pure-TS fixed-window fallback. Never throws.
 */
export const createRateLimiter = (options: RateLimiterOptions): RateLimiter => {
  if (native && typeof native.RateLimiter === "function") {
    const inst = new native.RateLimiter(
      options.limit,
      options.windowMs,
      options.maxEntries ?? null,
    );
    return {
      check(key, nowMs = Date.now()) {
        return inst.check(key, nowMs);
      },
    };
  }
  return createRateLimiterFallback(options);
};

/** Pure-TS fixed-window fallback mirroring the native limiter's semantics. */
export const createRateLimiterFallback = (options: RateLimiterOptions): RateLimiter => {
  const { limit, windowMs } = options;
  const maxEntries = Math.max(1, options.maxEntries ?? 1_000_000);
  const window = Math.max(1, Math.floor(windowMs));
  const state = new Map<string, { windowStart: number; count: number }>();

  return {
    check(key, nowMs = Date.now()) {
      const now = Math.floor(nowMs);
      const existing = state.get(key);

      if (!existing || now - existing.windowStart >= window) {
        state.set(key, { windowStart: now, count: 1 });
        if (state.size > maxEntries) {
          // Coarse eviction: drop any expired windows first; if still over,
          // clear the oldest key so the map can never grow unboundedly.
          for (const [k, v] of state) {
            if (now - v.windowStart >= window) state.delete(k);
          }
          if (state.size > maxEntries) {
            const oldest = state.keys().next().value;
            if (oldest !== undefined) state.delete(oldest);
          }
        }
        return {
          allowed: limit > 0,
          remaining: Math.max(0, limit - 1),
          resetMs: now + window,
        };
      }

      if (existing.count < limit) {
        existing.count++;
        return {
          allowed: true,
          remaining: Math.max(0, limit - existing.count),
          resetMs: existing.windowStart + window,
        };
      }

      return { allowed: false, remaining: 0, resetMs: existing.windowStart + window };
    },
  };
};
