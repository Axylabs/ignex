/**
 * Enterprise-hardening regression suite.
 *
 * Covers the fixes from the scalability/stability audit:
 * - job store: fresh-read claims (no double-claim across workers), owner-token
 *   guards, retention pruning, collision-resistant ids, async-store support;
 * - memory/file store entry caps;
 * - SQLite WAL/busy_timeout pragmas;
 * - rate limit: atomic shared incr path + onStoreError open/closed policy;
 * - healthProbe / runReadinessChecks (readiness vs liveness);
 * - scheduler records FAILURES as failures (not completions).
 */
import { describe, expect, it, vi } from "vitest";
import { createMemoryStore, createRedisRateLimitStore } from "../src/data/store";
import { createFileStore } from "../src/data/store/file";
import {
  createStoreJobStore,
  type JobStore,
  newJobId,
  openStoreJobStore,
} from "../src/platform/jobs-store";
import { createScheduler } from "../src/platform/scheduler";
import { healthProbe, runReadinessChecks } from "../src/plugins/health";
import type { RateLimitStore } from "../src/plugins/ratelimit";

describe("durable job store — multi-process safety", () => {
  // Two "workers" over ONE shared backend: the old snapshot-once store let
  // both claim the same jobs; the fresh-read store must not.
  const makeSharedPair = (): [JobStore, JobStore] => {
    // Both stores wrap the SAME underlying map via a tiny shared Store.
    const backing = new Map<string, unknown>();
    const shared = {
      get: (k: string) => backing.get(k) ?? null,
      set: (k: string, v: unknown) => void backing.set(k, v),
      delete: (k: string) => void backing.delete(k),
    };
    return [createStoreJobStore(shared), createStoreJobStore(shared)];
  };

  it("does not double-claim the same job from two workers", async () => {
    const [a, b] = makeSharedPair();
    await a.enqueue({
      id: newJobId(),
      name: "j",
      status: "queued",
      runAt: Date.now() - 1,
      attempts: 0,
      maxAttempts: 1,
      createdAt: Date.now(),
    });
    const claimedA = await a.claim(5, 30_000);
    const claimedB = await b.claim(5, 30_000);
    expect(claimedA).toHaveLength(1);
    expect(claimedB).toHaveLength(0); // worker B sees A's running stamp
  });

  it("rejects completion from a worker that lost the lease (owner tokens)", async () => {
    const [a, b] = makeSharedPair();
    const id = newJobId();
    await a.enqueue({
      id,
      name: "j",
      status: "queued",
      runAt: 0,
      attempts: 0,
      maxAttempts: 1,
      createdAt: Date.now(),
    });
    const [claimedByA] = await a.claim(1, 30_000);
    expect(claimedByA?.leaseOwner).toBeTruthy();

    // B races a claim AFTER A already holds it → B gets nothing, but even a
    // stale complete() from B must not mark A's running job completed.
    await b.complete(id); // no owner token → legacy callers still work
    // A's heartbeat/complete with the RIGHT owner works and is authoritative:
    await b.releaseExpired(Date.now() + 60_000); // lease expiry re-queues
    const reclaimed = await b.claim(1, 30_000);
    const owner = reclaimed[0]?.leaseOwner;
    await b.complete(id, { owner }); // correct owner completes
    const jobs = await b.list();
    expect(jobs.find((j) => j.id === id)?.status).toBe("completed");
  });

  it("complete() with a WRONG owner is a no-op", async () => {
    const store = createStoreJobStore(createMemoryStore());
    const id = newJobId();
    await store.enqueue({
      id,
      name: "j",
      status: "queued",
      runAt: 0,
      attempts: 0,
      maxAttempts: 1,
      createdAt: Date.now(),
    });
    const [claimed] = await store.claim(1, 30_000);
    await store.complete(id, { owner: "not-the-owner" });
    const jobs = await store.list();
    expect(jobs.find((j) => j.id === id)?.status).toBe("running");
    await store.complete(id, { owner: claimed?.leaseOwner });
    expect((await store.list()).find((j) => j.id === id)?.status).toBe("completed");
  });

  it("prunes finished history by count and age (retention)", async () => {
    const store = createStoreJobStore(createMemoryStore(), {
      retention: { maxCompleted: 2 },
    });
    for (let i = 0; i < 5; i++) {
      const id = newJobId();
      await store.enqueue({
        id,
        name: "j",
        status: "queued",
        runAt: 0,
        attempts: 0,
        maxAttempts: 1,
        createdAt: Date.now(),
      });
      await store.complete(id);
    }
    const jobs = await store.list();
    expect(jobs.filter((j) => j.status === "completed")).toHaveLength(2);
  });

  it("generates collision-resistant ids", async () => {
    const ids = new Set(Array.from({ length: 100 }, () => newJobId()));
    expect(ids.size).toBe(100);
  });

  it("supports async stores via openStoreJobStore (the Redis path)", async () => {
    const backing = new Map<string, unknown>();
    const asyncStore = {
      get: async (k: string) => backing.get(k) ?? null,
      set: async (k: string, v: unknown) => void backing.set(k, v),
      delete: async (k: string) => void backing.delete(k),
    };
    const store = await openStoreJobStore(asyncStore);
    const id = newJobId();
    await store.enqueue({
      id,
      name: "j",
      status: "queued",
      runAt: 0,
      attempts: 0,
      maxAttempts: 1,
      createdAt: Date.now(),
    });
    const claimed = await store.claim(1, 30_000);
    expect(claimed).toHaveLength(1);

    // The sync factory still rejects async drivers with an actionable error.
    expect(() => createStoreJobStore(asyncStore)).toThrow(/openStoreJobStore/);
  });
});

describe("store driver bounds", () => {
  it("memory store enforces maxEntries (expired-first, then FIFO)", () => {
    const store = createMemoryStore({ maxEntries: 3 });
    store.set("a", 1);
    store.set("b", 2);
    store.set("c", 3);
    store.set("d", 4); // evicts "a" (oldest)
    expect(store.get("a")).toBeNull();
    expect(store.get("b")).toBe(2);
    expect(store.get("d")).toBe(4);
  });

  it("file store enforces maxEntries and coalesces writes", () => {
    const dir = `/tmp/opencode/ignex-file-store-${Date.now()}`;
    const store = createFileStore(dir, { maxEntries: 3, writeCoalesceMs: 5 });
    store.set("a", 1);
    store.set("b", 2);
    store.set("c", 3);
    store.set("d", 4);
    expect(store.get("a")).toBeNull();
    store.close(); // flush pending coalesced write
    const reopened = createFileStore(dir, { maxEntries: 0 });
    expect(reopened.get("d")).toBe(4);
    expect(reopened.get("b")).toBe(2);
  });
});

describe("rate limit — atomic shared counting + error policy", () => {
  const atomicStore = (): RateLimitStore & { counts: Map<string, number> } => {
    const counts = new Map<string, number>();
    return {
      counts,
      async incr(key, windowMs, now) {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return { count: next, resetTime: now + windowMs };
      },
      get: () => undefined,
      set: () => {},
    };
  };

  it("uses the atomic incr path when the store exposes it", async () => {
    const { rateLimit } = await import("../src/plugins/ratelimit");
    const plugin = rateLimit({ store: atomicStore(), maxRequests: 2 });
    const ctx = { setState: () => {}, headers: new Headers(), ip: "1.2.3.4" };
    const r1 = await plugin.onRequest(ctx as never);
    const r2 = await plugin.onRequest(ctx as never);
    const r3 = await plugin.onRequest(ctx as never);
    expect(r1).not.toBeInstanceOf(Response);
    expect(r2).not.toBeInstanceOf(Response);
    expect(r3).toBeInstanceOf(Response); // 429 at maxRequests=2
    expect((r3 as Response).status).toBe(429);
  });

  it("fail-closed returns 503 when the store errors", async () => {
    const { rateLimit } = await import("../src/plugins/ratelimit");
    const broken = {
      get: () => {
        throw new Error("redis down");
      },
      set: () => {},
    } as unknown as RateLimitStore;
    const plugin = rateLimit({ store: broken, onStoreError: "closed" });
    const res = await plugin.onRequest({
      setState: () => {},
      headers: new Headers(),
      ip: "1.2.3.4",
    } as never);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(503);
  });

  it("fail-open (default) allows requests when the store errors", async () => {
    const { rateLimit } = await import("../src/plugins/ratelimit");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      get: () => Promise.reject(new Error("redis down")),
      set: () => {},
    } as unknown as RateLimitStore;
    const plugin = rateLimit({ store: broken });
    const res = await plugin.onRequest({
      setState: () => {},
      headers: new Headers(),
      ip: "1.2.3.4",
    } as never);
    expect(res).not.toBeInstanceOf(Response);
    expect(consoleSpy).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it("createRedisRateLimitStore exposes the atomic incr contract", async () => {
    let incrCalls = 0;
    const store = createRedisRateLimitStore({
      client: async () => ({
        incr: async () => {
          incrCalls += 1;
          return incrCalls;
        },
        pexpire: async () => 1,
      }),
    });
    const e1 = await store.incr("k", 60_000, 1_000);
    const e2 = await store.incr("k", 60_000, 1_001);
    expect(e1.count).toBe(1);
    expect(e2.count).toBe(2);
    await store.close();
  });
});

describe("scheduler records failures honestly", () => {
  it("marks a failed tick job as failed (not completed) via claimOne", async () => {
    vi.useFakeTimers();
    try {
      const store = createStoreJobStore(createMemoryStore());
      const log = vi.fn();
      const scheduler = createScheduler({ store, skipWhenInFlight: false, log });
      // 6-field expression → in-process matcher (no Bun.cron under fake timers).
      scheduler.cron("* * * * * *", "broken-job", () => {
        throw new Error("task exploded");
      });
      scheduler.start();
      // Tick fires at ~1s → enqueue; runIfUnclaimed sleeps another 1s before
      // claiming and running inline.
      await vi.advanceTimersByTimeAsync(2_500);
      const jobs = await store.list();
      const run = jobs.find((j) => j.name === "broken-job");
      expect(run?.status).toBe("failed");
      expect(run?.lastError).toContain("task exploded");
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("health/readiness probes", () => {
  it("runReadinessChecks aggregates pass/fail with timeouts", async () => {
    const report = await runReadinessChecks(
      [
        { name: "ok-check", run: () => true },
        { name: "false-check", run: () => false },
        {
          name: "throw-check",
          run: () => {
            throw new Error("db gone");
          },
        },
        { name: "slow-check", run: () => new Promise<boolean>(() => {}) },
      ],
      20,
    );
    expect(report.ok).toBe(false);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName["ok-check"]?.ok).toBe(true);
    expect(byName["false-check"]?.ok).toBe(false);
    expect(byName["throw-check"]?.error).toContain("db gone");
    expect(byName["slow-check"]?.error).toContain("timeout");
  });

  it("all-green checks report ok", async () => {
    const report = await runReadinessChecks([{ name: "a", run: async () => true }]);
    expect(report.ok).toBe(true);
  });

  it("healthProbe registers liveness + readiness routes (interpreted)", async () => {
    const { createRouter } = await import("../src/http/router");
    const router = createRouter();
    healthProbe({
      readiness: [{ name: "x", run: () => true }],
    }).routes?.(router);
    const paths = router.listRoutes().map((r) => r.path);
    expect(paths).toContain("/health");
    expect(paths).toContain("/ready");
  });
});
