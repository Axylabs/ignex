/**
 * @fileoverview Pure rate-limit state machines — fixed-window, sliding-window
 * (weighted previous-window counter), and token bucket. No timers, no storage:
 * each check is a pure function over `(config, entry, now)` returning a
 * decision plus the next per-key state to persist, so the algorithms are
 * unit-testable in isolation and share one store.
 */

export type RateLimitAlgorithm = "fixed-window" | "sliding-window" | "token-bucket";

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface RateDecision {
  allowed: boolean;
  /** Remaining requests allowed (clamped at 0). */
  remaining: number;
  /** Epoch ms at which the limit is expected to reset. */
  resetMs: number;
  /** Next per-key state to persist. */
  state: FixedWindowEntry | SlidingWindowEntry | TokenBucketEntry;
}

export interface FixedWindowEntry {
  count: number;
  resetTime: number;
}

export interface SlidingWindowEntry {
  windowStart: number;
  count: number;
  prevCount: number;
}

export interface TokenBucketEntry {
  tokens: number;
  lastRefill: number;
}

export const freshFixedWindow = (now: number, windowMs: number): FixedWindowEntry => ({
  count: 0,
  resetTime: now + windowMs,
});

export const freshSlidingWindow = (now: number): SlidingWindowEntry => ({
  windowStart: now,
  count: 0,
  prevCount: 0,
});

export const freshTokenBucket = (now: number, capacity: number): TokenBucketEntry => ({
  tokens: capacity,
  lastRefill: now,
});

/**
 * Fixed-window: at most `maxRequests` per `windowMs`, counted per aligned
 * window that starts at the first request.
 */
export const checkFixedWindow = (
  config: RateLimitConfig,
  entry: FixedWindowEntry,
  now: number,
): RateDecision => {
  const next =
    entry.resetTime <= now
      ? { ...freshFixedWindow(now, config.windowMs), count: 1 }
      : { ...entry, count: entry.count + 1 };

  return {
    allowed: next.count <= config.maxRequests,
    remaining: Math.max(0, config.maxRequests - next.count),
    resetMs: next.resetTime,
    state: next,
  };
};

/**
 * Sliding-window counter (weighted previous window): approximates a true
 * rolling window with O(1) state — `prevCount` decays by the fraction of the
 * current window already elapsed. Smoother than fixed-window while keeping
 * memory bounded.
 */
export const checkSlidingWindow = (
  config: RateLimitConfig,
  entry: SlidingWindowEntry,
  now: number,
): RateDecision => {
  let next = entry;
  const elapsedWindows = Math.floor((now - entry.windowStart) / config.windowMs);

  if (elapsedWindows >= 1) {
    next = {
      windowStart: entry.windowStart + elapsedWindows * config.windowMs,
      count: 0,
      // Only the immediately-previous window contributes; older windows have
      // fully expired.
      prevCount: elapsedWindows >= 2 ? 0 : entry.count,
    };
  }

  const weight = Math.min(1, Math.max(0, (now - next.windowStart) / config.windowMs));
  const estimated = next.prevCount * (1 - weight) + next.count;
  const consumed = Math.floor(estimated) + 1;

  return {
    allowed: consumed <= config.maxRequests,
    remaining: Math.max(0, config.maxRequests - consumed),
    resetMs: next.windowStart + config.windowMs,
    state: { ...next, count: next.count + 1 },
  };
};

/**
 * Token bucket: refills at `maxRequests / windowMs` tokens per ms up to a
 * capacity of `maxRequests` (the burst allowance). A request consumes one
 * token when available.
 */
export const checkTokenBucket = (
  config: RateLimitConfig,
  entry: TokenBucketEntry,
  now: number,
): RateDecision => {
  const capacity = config.maxRequests;
  const ratePerMs = capacity / config.windowMs;
  const elapsed = Math.max(0, now - entry.lastRefill);
  const refilled = Math.min(capacity, entry.tokens + elapsed * ratePerMs);
  const allowed = refilled >= 1;
  const nextTokens = allowed ? refilled - 1 : refilled;
  const resetMs = entry.lastRefill + Math.ceil((capacity - entry.tokens) / ratePerMs);

  return {
    allowed,
    remaining: Math.max(0, Math.floor(nextTokens)),
    resetMs: Math.max(now, resetMs),
    state: { tokens: nextTokens, lastRefill: now },
  };
};
