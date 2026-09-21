/**
 * @fileoverview Purity tests for `createScheduler` job ids.
 *
 * Job ids were `sched-<ms>-<seq>-<rand8>` where `<seq>` came from a MODULE-LEVEL
 * counter (shared by every scheduler in the process) and `<rand8>` from
 * `Math.random()`. This suite pins the fix: per-scheduler counters and a
 * crypto-random suffix (unique across processes, no sequential-only guess).
 */

import {
  createMemoryStore,
  createScheduler,
  createStoreJobStore,
  type JobStore,
  type StoredJob,
} from "@ignex/core";
import { describe, expect, it } from "vitest";

const makeScheduler = () => {
  const store = createStoreJobStore(createMemoryStore()) as JobStore;
  const scheduler = createScheduler({ store, skipWhenInFlight: false, log: () => {} });
  return { store, scheduler };
};

const flush = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The per-scheduler sequence segment of a job id (`sched-<ms>-<seq>-<rand>`). */
const seqOf = (id: string): string => id.split("-")[2] as string;

describe("createScheduler — job-id purity", () => {
  it("mints instance-scoped sequence counters per scheduler", async () => {
    // Scheduler A enqueues a few jobs first…
    const a = makeScheduler();
    a.scheduler.cron("* * * * * *", "a-tick", async () => {});
    a.scheduler.start();
    await flush(2600);
    a.scheduler.stop();
    const aJobs = (await a.store.list()).filter((job) => job.name === "a-tick");
    expect(aJobs.length).toBeGreaterThanOrEqual(2);

    // …then scheduler B starts its sequence at 1 (a module counter would
    // continue A's sequence instead).
    const b = makeScheduler();
    b.scheduler.cron("* * * * * *", "b-tick", async () => {});
    b.scheduler.start();
    await flush(2600);
    b.scheduler.stop();
    const bJobs = (await b.store.list()).filter((job) => job.name === "b-tick");
    expect(bJobs.length).toBeGreaterThanOrEqual(1);
    expect(seqOf((bJobs[0] as StoredJob).id)).toBe("1");
  });

  it("keeps ids unique across two schedulers sharing one store", async () => {
    const store = createStoreJobStore(createMemoryStore()) as JobStore;
    const a = createScheduler({ store, skipWhenInFlight: false, log: () => {} });
    a.cron("* * * * * *", "u-a", async () => {});
    a.start();
    await flush(1600);
    a.stop();

    const b = createScheduler({ store, skipWhenInFlight: false, log: () => {} });
    b.cron("* * * * * *", "u-b", async () => {});
    b.start();
    await flush(1600);
    b.stop();

    const all = await store.list();
    const ids = all.map((job) => job.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("emits sched-<ms>-<seq>-<crypto-hex> job ids", async () => {
    const { store, scheduler } = makeScheduler();
    scheduler.cron("* * * * * *", "fmt-tick", async () => {});
    scheduler.start();
    await flush(1600);
    scheduler.stop();
    const jobs = await store.list();
    const job = jobs.find((entry) => entry.name === "fmt-tick");
    expect(job?.id).toMatch(/^sched-\d+-\d+-[0-9a-f]{12}$/);
  });
});
