/**
 * Rate-limit depth tests: the pure algorithms (`data/ratelimit.ts`), the
 * plugin's `algorithm` option through `createApp`, and two property
 * invariants over generated request timelines.
 */
import * as fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkFixedWindow,
  checkSlidingWindow,
  checkTokenBucket,
  type FixedWindowEntry,
  freshFixedWindow,
  freshSlidingWindow,
  freshTokenBucket,
  type SlidingWindowEntry,
  type TokenBucketEntry,
} from "../src/data/ratelimit.js";
import { createApp, rateLimit } from "../src/index.js";

const req = (url: string) => new Request(`http://x${url}`);

describe("pure fixed-window", () => {
  it("allows up to maxRequests, then blocks, then resets after the window", () => {
    const config = { windowMs: 1000, maxRequests: 3 };
    let entry = freshFixedWindow(1000, 1000);

    for (let i = 0; i < 3; i++) {
      const d = checkFixedWindow(config, entry, 1000);
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(3 - (i + 1));
      entry = d.state as FixedWindowEntry;
    }

    const blocked = checkFixedWindow(config, entry, 1000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);

    const after = checkFixedWindow(config, entry, 2001);
    expect(after.allowed).toBe(true);
    expect((after.state as FixedWindowEntry).count).toBe(1);
  });
});

describe("pure sliding-window", () => {
  it("blocks a burst and relaxes as the previous window decays", () => {
    const config = { windowMs: 1000, maxRequests: 2 };
    let entry = freshSlidingWindow(0);

    for (let i = 0; i < 2; i++) {
      entry = checkSlidingWindow(config, entry, 0).state as SlidingWindowEntry;
    }
    expect(checkSlidingWindow(config, entry, 0).allowed).toBe(false);

    // At t=1500 the previous window is half-expired (weight 0.5): the 2 old
    // requests count as ~1, so a new request is allowed.
    const mid = checkSlidingWindow(config, entry, 1500);
    expect(mid.allowed).toBe(true);
    expect((mid.state as SlidingWindowEntry).prevCount).toBe(2);
  });

  it("drops the previous window entirely after two windows elapse", () => {
    const config = { windowMs: 1000, maxRequests: 2 };
    const entry = checkSlidingWindow(config, freshSlidingWindow(0), 0).state as SlidingWindowEntry;

    const far = checkSlidingWindow(config, entry, 2500);
    expect(far.allowed).toBe(true);
    expect((far.state as SlidingWindowEntry).prevCount).toBe(0);
    expect((far.state as SlidingWindowEntry).windowStart).toBe(2000);
  });
});

describe("pure token-bucket", () => {
  it("allows a burst up to capacity, blocks when empty, and refills", () => {
    const config = { windowMs: 1000, maxRequests: 2 };
    let entry = freshTokenBucket(0, 2);

    for (let i = 0; i < 2; i++) {
      const d = checkTokenBucket(config, entry, 0);
      expect(d.allowed).toBe(true);
      entry = d.state as TokenBucketEntry;
    }

    const blocked = checkTokenBucket(config, entry, 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.resetMs).toBeGreaterThan(0);

    // After 500ms the bucket has refilled 1 token (rate 2/s).
    const refilled = checkTokenBucket(config, blocked.state as TokenBucketEntry, 500);
    expect(refilled.allowed).toBe(true);
  });

  it("never refills above capacity (and consumes the checking token)", () => {
    const config = { windowMs: 1000, maxRequests: 5 };
    const idle = checkTokenBucket(config, freshTokenBucket(0, 5), 10_000);
    expect(idle.allowed).toBe(true); // bucket was full → a request is allowed
    expect((idle.state as TokenBucketEntry).tokens).toBe(4); // full minus one consumed
  });
});

describe("rateLimit plugin algorithms", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const appWith = (
    algorithm: "fixed-window" | "sliding-window" | "token-bucket",
    maxRequests: number,
  ) =>
    createApp({
      plugins: [rateLimit({ windowMs: 1000, maxRequests, algorithm })],
      handler: () => new Response("ok"),
    });

  it("sliding-window limits bursts and releases after the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const app = appWith("sliding-window", 2);

    expect((await app.handler(req("/"))).status).toBe(200);
    expect((await app.handler(req("/"))).status).toBe(200);
    const blocked = await app.handler(req("/"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("x-ratelimit-limit")).toBe("2");
    expect(blocked.headers.get("x-ratelimit-remaining")).toBe("0");

    vi.setSystemTime(2500);
    expect((await app.handler(req("/"))).status).toBe(200);
  });

  it("token-bucket allows a burst then blocks and refills over time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const app = appWith("token-bucket", 2);

    expect((await app.handler(req("/"))).status).toBe(200);
    expect((await app.handler(req("/"))).status).toBe(200);
    expect((await app.handler(req("/"))).status).toBe(429);

    vi.setSystemTime(1500); // one token refilled (2 req/s)
    const ok = await app.handler(req("/"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  it("keeps fixed-window as the default with identical semantics", async () => {
    const app = createApp({
      plugins: [rateLimit({ windowMs: 60_000, maxRequests: 1 })],
      handler: () => new Response("ok"),
    });
    expect((await app.handler(req("/"))).status).toBe(200);
    expect((await app.handler(req("/"))).status).toBe(429);
  });
});

describe("rate-limit property invariants", () => {
  it("token bucket never over-spends across a simulated timeline", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 100 }),
        fc.constantFrom(5, 10, 20),
        (offsets, maxRequests) => {
          const config = { windowMs: 1000, maxRequests };
          let entry = freshTokenBucket(0, maxRequests);
          let allowed = 0;
          let t = 0;
          for (const offset of offsets) {
            t += offset;
            const d = checkTokenBucket(config, entry, t);
            if (d.allowed) allowed += 1;
            entry = d.state as TokenBucketEntry;
          }
          // Allowed ≤ initial capacity + continuous refill (plus float slack).
          const budget = Math.ceil(maxRequests + (t * maxRequests) / 1000) + 1;
          expect(allowed).toBeLessThanOrEqual(budget);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("fixed window allows at most 2× maxRequests in any aligned window", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5000 }), { maxLength: 200 }),
        fc.constantFrom(3, 5, 10),
        (offsets, maxRequests) => {
          const config = { windowMs: 1000, maxRequests };
          let entry = freshFixedWindow(0, 1000);
          const perWindow = new Map<number, number>();
          let t = 0;
          for (const offset of offsets) {
            t += offset;
            const d = checkFixedWindow(config, entry, t);
            if (d.allowed) {
              const window = Math.floor(t / 1000);
              perWindow.set(window, (perWindow.get(window) ?? 0) + 1);
            }
            entry = d.state as FixedWindowEntry;
          }
          // An aligned window can straddle at most two reset cycles.
          for (const count of perWindow.values()) {
            expect(count).toBeLessThanOrEqual(2 * maxRequests);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
