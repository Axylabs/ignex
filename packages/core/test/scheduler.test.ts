/**
 * `createScheduler` — cron-expression scheduling on the durable job store.
 *
 * Covers: cron registration, tick → durable enqueue, the overlap guard
 * (skip when a previous run is in flight), and stop/start. Uses a memory
 * store so no files/DB are needed.
 */

import {
  createMemoryStore,
  createScheduler,
  createStoreJobStore,
  type JobStore,
} from "@ignex/core";
import { afterEach, describe, expect, it, vi } from "vitest";

/** A fresh memory-backed job store + scheduler. */
function makeScheduler(skipWhenInFlight = true) {
  const store = createStoreJobStore(createMemoryStore()) as JobStore;
  const scheduler = createScheduler({ store, skipWhenInFlight, log: () => {} });
  return { store, scheduler };
}

const flush = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.useRealTimers();
});

describe("createScheduler", () => {
  it("runs a cron task and records a durable job", async () => {
    const { store, scheduler } = makeScheduler();
    const task = vi.fn(async () => {});
    // Every second (6-field → in-process fallback; Bun.cron itself is
    // minute-granularity).
    scheduler.cron("* * * * * *", "test-tick", task);
    scheduler.start();

    await flush(2600);
    scheduler.stop();

    expect(task).toHaveBeenCalled();
    const jobs = await store.list();
    expect(jobs.some((j) => j.name === "test-tick")).toBe(true);
  });

  it("skips a tick while the previous run is in flight (overlap guard)", async () => {
    const { scheduler } = makeScheduler(true);
    let runs = 0;
    let release: () => void = () => {};
    scheduler.cron("* * * * * *", "slow", async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    scheduler.start();

    await flush(2300); // first tick starts, holds the promise
    await flush(2300); // later ticks should be skipped (first still running)
    scheduler.stop();
    release();

    // The overlap guard means at most 1 run started despite 2+ ticks.
    expect(runs).toBeLessThanOrEqual(1);
  });

  it("stop() halts future ticks", async () => {
    const { scheduler } = makeScheduler();
    const task = vi.fn(async () => {});
    scheduler.cron("* * * * * *", "stopped-tick", task);
    scheduler.start();
    await flush(2200);
    scheduler.stop();

    // A tick enqueued just before stop() may still be running inline (the
    // scheduler waits ~1s before claiming it). Let any in-flight run settle,
    // THEN assert no NEW ticks fire after stop().
    await flush(1500);
    const before = task.mock.calls.length;
    await flush(1200);
    expect(task.mock.calls.length).toBe(before);
  });

  it("exposes scheduled job names and replace-on-re-register", async () => {
    const { scheduler } = makeScheduler();
    scheduler.cron("* * * * * *", "dup", async () => {});
    expect(scheduler.jobs).toContain("dup");
    scheduler.cron("* * * * * *", "dup", async () => {});
    expect(scheduler.jobs.filter((n) => n === "dup").length).toBe(1);
  });

  it("rejects an invalid cron expression at registration", () => {
    const { scheduler } = makeScheduler();
    expect(() => scheduler.cron("not-a-cron", "bad", async () => {})).toThrow();
  });

  it("routes 5-field expressions through Bun.cron (real tick, gated)", async () => {
    // The Bun.cron transport fires at minute granularity, so this test waits
    // for the next minute boundary (up to 60s). It only runs when explicitly
    // requested (nightly job) — CI PR runs keep the fast 6-field path only.
    if (process.env.IGNEX_SCHEDULER_REAL_TICK !== "1") {
      return;
    }
    const { store, scheduler } = makeScheduler();
    const task = vi.fn(async () => {});
    // Every minute: the next fire lands on the upcoming minute boundary (≤60s).
    scheduler.cron("* * * * *", "real-bun-cron", task);
    scheduler.start();
    const deadline = Date.now() + 70_000;
    while (Date.now() < deadline && task.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    scheduler.stop();
    expect(task).toHaveBeenCalled();
    const jobs = await store.list();
    expect(jobs.some((j) => j.name === "real-bun-cron")).toBe(true);
  });
});
