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
    // Every 100ms (croner supports sub-minute).
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
});
