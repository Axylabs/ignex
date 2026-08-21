/**
 * Stability hardening regression tests (2026-08-19).
 *
 * Covers the Phase-1 production-readiness fixes that previously had no
 * coverage:
 *   - plugin `init` failures PROPAGATE (`createApp().init()` rejects), while
 *     later plugins still initialize (allSettled semantics preserved);
 *   - `strictInit: true` NEVER binds the listener when init fails (was dead
 *     code — `initAll` used allSettled and swallowed every rejection);
 *   - best-effort (default) still binds and keeps serving on init failure;
 *   - async `onStart` defers listener binding so requests never race it;
 *   - `stop()` never hangs on a stuck plugin `close()` (hard deadline);
 *   - durable queue can be restarted after `stop()` (was permanently dead);
 *   - a per-job STORE failure (complete/fail/enqueue throws) is surfaced via
 *     `onError` instead of becoming an unhandled rejection.
 */
import { createApp, DEFAULT_SERVER_IDLE_TIMEOUT, type IgnexPlugin } from "@ignex/core";
import type { JobStore, StoredJob } from "@ignex/core/jobs";
import { createDurableJobQueue } from "@ignex/core/jobs";
import { afterEach, describe, expect, it, vi } from "vitest";

/** A plugin whose `init` rejects (e.g. a DB connection failing at boot). */
const failingInitPlugin = (name = "failer"): IgnexPlugin & { initCalled: boolean } => {
  const plugin: IgnexPlugin & { initCalled: boolean } = {
    initCalled: false,
    async init() {
      plugin.initCalled = true;
      throw new Error(`plugin ${name} init failed`);
    },
  };
  return plugin;
};

/** A plugin whose `close` never resolves (leaked socket / stuck cleanup). */
const stuckClosePlugin = (): IgnexPlugin => ({
  close: () => new Promise<void>(() => {}),
});

/** Stub `Bun` so `createApp().serve()` doesn't bind a real port. */
const stubBun = (): { serve: ReturnType<typeof vi.fn> } => {
  const serve = vi.fn(() => ({ stop: vi.fn() }));
  vi.stubGlobal("Bun", {
    serve,
    which: vi.fn(() => null),
    spawnSync: vi.fn(() => ({ exitCode: 0, stderr: "" })),
    file: vi.fn((p: string) => ({ path: p })),
  });
  return { serve };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("plugin init failure propagation", () => {
  it("app.init() rejects when a plugin init throws", async () => {
    const app = createApp({
      plugins: [failingInitPlugin()],
      handler: () => new Response("ok"),
    });
    await expect(app.init()).rejects.toThrow(/init failed/);
  });

  it("still initializes later plugins after a failure (allSettled preserved)", async () => {
    let laterInitCalled = false;
    const failing = failingInitPlugin("first");
    const later: IgnexPlugin = {
      init: () => {
        laterInitCalled = true;
      },
    };
    const app = createApp({
      plugins: [failing, later],
      handler: () => new Response("ok"),
    });
    await expect(app.init()).rejects.toThrow(/init failed/);
    expect(laterInitCalled).toBe(true);
    expect(failing.initCalled).toBe(true);
  });
});

describe("strictInit fail-closed", () => {
  it("never binds the listener when a plugin init fails", async () => {
    const { serve } = stubBun();
    const app = createApp({
      strictInit: true,
      plugins: [failingInitPlugin()],
      handler: () => new Response("ok"),
    });
    app.serve({ https: false, port: 0 });
    await flush();
    expect(serve).not.toHaveBeenCalled();
  });

  it("binds the listener when every plugin initializes", async () => {
    const { serve } = stubBun();
    const app = createApp({
      strictInit: true,
      handler: () => new Response("ok"),
    });
    app.serve({ https: false, port: 0 });
    await flush();
    expect(serve).toHaveBeenCalledTimes(1);
  });
});

describe("best-effort init (default)", () => {
  it("still binds and serves when a plugin init fails (log + continue)", async () => {
    const { serve } = stubBun();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({
      plugins: [failingInitPlugin()],
      handler: () => new Response("ok"),
    });
    app.serve({ https: false, port: 0 });
    await flush();
    expect(serve).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ignex] plugin init failed:"),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });
});

describe("onStart ordering", () => {
  it("defers binding until an async onStart resolves", async () => {
    const { serve } = stubBun();
    let started = false;
    const gate = new Promise<void>((resolve) => {
      setTimeout(() => {
        started = true;
        resolve();
      }, 10);
    });
    const app = createApp({
      onStart: async () => {
        await gate;
      },
      handler: () => new Response("ok"),
    });
    app.serve({ https: false, port: 0 });
    expect(serve).not.toHaveBeenCalled();
    await gate;
    await flush();
    expect(started).toBe(true);
    expect(serve).toHaveBeenCalledTimes(1);
  });
});

describe("stop() shutdown deadline", () => {
  it("resolves even when a plugin close() never completes", async () => {
    const app = createApp({
      plugins: [stuckClosePlugin()],
      handler: () => new Response("ok"),
    });
    const started = Date.now();
    await app.stop({ stopDeadlineMs: 60 });
    // Returns via the deadline, not by waiting forever.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

/** Minimal in-memory JobStore (mirrors the file store's semantics). */
const inMemoryStore = (opts: { failOnFail?: boolean } = {}): JobStore => {
  const jobs = new Map<string, StoredJob>();
  const store: JobStore = {
    async enqueue(job) {
      jobs.set(job.id, job);
    },
    async claim(limit, leaseMs, now = Date.now()) {
      const due = [...jobs.values()]
        .filter((job) => job.status === "queued" && job.runAt <= now)
        .sort((a, b) => a.runAt - b.runAt)
        .slice(0, Math.max(0, limit));
      for (const job of due) {
        job.status = "running";
        job.leaseUntil = now + leaseMs;
      }
      return due;
    },
    async complete(id) {
      const job = jobs.get(id);
      if (job) job.status = "completed";
    },
    async fail(id, error) {
      // A store I/O failure while recording a failed job — the path that
      // used to produce an unhandled rejection (runClaimed rejects, the
      // fire-and-forget `.finally` had no rejection handler).
      if (opts.failOnFail) throw new Error("store.fail failed (disk I/O)");
      const job = jobs.get(id);
      if (job) {
        job.status = "failed";
        job.lastError = error instanceof Error ? error.message : String(error);
      }
    },
    async heartbeat(id, until) {
      const job = jobs.get(id);
      if (job) job.leaseUntil = until;
    },
    async releaseExpired(now = Date.now()) {
      let count = 0;
      for (const job of jobs.values()) {
        if (job.status === "running" && job.leaseUntil != null && job.leaseUntil < now) {
          job.status = "queued";
          delete job.leaseUntil;
          count += 1;
        }
      }
      return count;
    },
    async list() {
      return [...jobs.values()];
    },
  };
  return store;
};

describe("durable queue restart-after-stop", () => {
  it("runs jobs again after stop() → start()", async () => {
    const store = inMemoryStore();
    const seen: string[] = [];
    const queue = createDurableJobQueue({
      store,
      handlers: {
        work: (payload) => {
          seen.push(String(payload));
        },
      },
      pollIntervalMs: 10,
    });
    await store.enqueue({
      id: "job-1",
      name: "work",
      payload: "first",
      runAt: 0,
      attempts: 0,
      maxAttempts: 1,
      status: "queued",
      createdAt: Date.now(),
    });
    queue.start();
    await vi.waitFor(() => expect(seen).toContain("first"));
    await queue.stop();

    // Previously `stopped` was never reset — a restarted queue never claimed
    // again (permanently dead). Now it must process a second job.
    await store.enqueue({
      id: "job-2",
      name: "work",
      payload: "second",
      runAt: 0,
      attempts: 0,
      maxAttempts: 1,
      status: "queued",
      createdAt: Date.now(),
    });
    queue.start();
    await vi.waitFor(() => expect(seen).toContain("second"));
    await queue.stop();
  });
});

describe("durable queue per-job store failure", () => {
  it("surfaces a store.fail failure via onError (not an unhandled rejection)", async () => {
    // The handler throws (normal job failure), then recording that failure in
    // the store ALSO throws (I/O error). `runClaimed` rejects — this is the
    // path that previously became an unhandled rejection via the fire-and-
    // forget `void task.finally(...)`.
    const store = inMemoryStore({ failOnFail: true });
    const errors: unknown[] = [];
    const queue = createDurableJobQueue({
      store,
      handlers: {
        work: () => {
          throw new Error("handler boom");
        },
      },
      pollIntervalMs: 10,
      onError: (err) => {
        errors.push(err);
      },
    });
    await store.enqueue({
      id: "job-broken",
      name: "work",
      runAt: 0,
      attempts: 0,
      maxAttempts: 1,
      status: "queued",
      createdAt: Date.now(),
    });
    // A stray unhandled rejection in this test would fail the run; the
    // queue must route the store failure to `onError` instead.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    queue.start();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    await queue.stop();
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });
});

describe("server idleTimeout default", () => {
  it("applies DEFAULT_SERVER_IDLE_TIMEOUT when the app sets no idleTimeout", async () => {
    const { serve } = stubBun();
    const app = createApp({
      handler: () => new Response("ok"),
    });
    app.serve({ https: false, port: 0 });
    await flush();
    expect(serve).toHaveBeenCalledTimes(1);
    const opts = serve.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.idleTimeout).toBe(DEFAULT_SERVER_IDLE_TIMEOUT);
  });

  it("respects an explicit server idleTimeout override", async () => {
    const { serve } = stubBun();
    const app = createApp({
      handler: () => new Response("ok"),
    });
    app.serve({ https: false, port: 0, idleTimeout: 120 });
    await flush();
    const opts = serve.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.idleTimeout).toBe(120);
  });
});
