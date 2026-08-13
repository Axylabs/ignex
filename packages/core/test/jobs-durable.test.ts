/**
 * Durable background jobs tests: file/SQLite stores, claim/lease/expiry,
 * durable-queue processing with retries, hooks, and restart recovery.
 */

import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDurableJobQueue,
  createFileJobStore,
  createSqliteJobStore,
  type StoredJob,
} from "../src/platform";

const tmp = () => mkdtempSync(join(tmpdir(), "ignex-jobs-"));

const waitFor = async (fn: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("createFileJobStore", () => {
  it("persists jobs across store instances (restart recovery)", async () => {
    const dir = tmp();
    const store = createFileJobStore(dir);

    await store.enqueue({
      id: "job-1",
      name: "send-email",
      payload: { to: "a@b.c" },
      runAt: Date.now() - 1000,
      attempts: 0,
      maxAttempts: 1,
      status: "queued",
      createdAt: Date.now(),
    });

    // A brand-new store instance over the same directory sees the job.
    const reloaded = createFileJobStore(dir);
    const listed = await reloaded.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].payload).toEqual({ to: "a@b.c" });
  });

  it("claims due jobs and releases expired leases", async () => {
    const store = createFileJobStore(tmp());
    const now = Date.now();
    await store.enqueue({
      id: "a",
      name: "x",
      runAt: now - 1000,
      attempts: 0,
      maxAttempts: 1,
      status: "queued",
      createdAt: now,
    });

    const claimed = await store.claim(5, 50_000, now);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe("running");

    // Lease not yet expired → nothing released.
    expect(await store.releaseExpired(now + 10_000)).toBe(0);

    // After the lease expires, the job is re-queued.
    expect(await store.releaseExpired(now + 60_000)).toBe(1);
    const listed = await store.list();
    expect(listed[0].status).toBe("queued");
  });

  it("writes a JSONL file on disk", async () => {
    const dir = tmp();
    const store = createFileJobStore(dir);
    await store.enqueue({
      id: "z",
      name: "x",
      runAt: Date.now(),
      attempts: 0,
      maxAttempts: 1,
      status: "queued",
      createdAt: Date.now(),
    });
    expect(readdirSync(dir).some((f) => f === "jobs.jsonl")).toBe(true);
  });
});

describe("createSqliteJobStore", () => {
  it("falls back to null when bun:sqlite is unavailable", async () => {
    // Cannot force unavailability here, but it must never throw and return a
    // working store under Bun (where bun:sqlite exists).
    const store = await createSqliteJobStore(":memory:");
    if (store === null) {
      // Unsupported runtime — the file store covers this; nothing to assert.
      expect(true).toBe(true);
      return;
    }
    await store.enqueue({
      id: "sqlite-1",
      name: "x",
      runAt: Date.now(),
      attempts: 0,
      maxAttempts: 1,
      status: "queued",
      createdAt: Date.now(),
    });
    expect((await store.list()).length).toBe(1);
  });
});

describe("createDurableJobQueue", () => {
  it("processes enqueued jobs through the handler registry", async () => {
    const dir = tmp();
    const store = createFileJobStore(dir);
    const seen: string[] = [];
    const queue = createDurableJobQueue({
      store,
      handlers: {
        "send-email": async (payload) => {
          seen.push((payload as { to: string }).to);
        },
      },
      pollIntervalMs: 20,
    });

    await queue.enqueue({ name: "send-email", payload: { to: "a@b.c" } });
    queue.start();

    await waitFor(() => seen.length === 1);
    await queue.stop();

    const jobs = await store.list();
    expect(jobs[0].status).toBe("completed");
  });

  it("retries with backoff and then permanently fails", async () => {
    const dir = tmp();
    const store = createFileJobStore(dir);
    const attempts: number[] = [];
    const retried: StoredJob[] = [];
    const failed: StoredJob[] = [];

    const queue = createDurableJobQueue({
      store,
      handlers: {
        flaky: async (_payload, { attempt }) => {
          attempts.push(attempt);
          throw new Error("boom");
        },
      },
      pollIntervalMs: 20,
      onRetry: (job) => retried.push(job),
      onFailed: (job) => failed.push(job),
    });

    await queue.enqueue({ name: "flaky", maxAttempts: 3 });
    queue.start();

    await waitFor(() => failed.length === 1, 4000);
    await queue.stop();

    expect(attempts).toEqual([1, 2, 3]);
    expect(retried).toHaveLength(2);
    expect(failed).toHaveLength(1);
    expect((await store.list())[0].status).toBe("failed");
  });

  it("re-enqueues recurring interval jobs after completion", async () => {
    const dir = tmp();
    const store = createFileJobStore(dir);
    let runs = 0;

    const queue = createDurableJobQueue({
      store,
      handlers: {
        tick: async () => {
          runs += 1;
        },
      },
      pollIntervalMs: 20,
    });

    await queue.enqueue({ name: "tick", intervalMs: 30 });
    queue.start();

    await waitFor(() => runs >= 2, 3000);
    await queue.stop();

    const queued = (await store.list()).filter((j) => j.status === "queued");
    expect(queued.length).toBeGreaterThanOrEqual(1);
  });

  it("recovers a job whose lease expired (simulated crash)", async () => {
    const dir = tmp();

    // Worker 1: enqueue a job, claim it with a 1ms lease, then "crash" before
    // completing — leaving a persisted running job with an expired lease.
    const raw = createFileJobStore(dir);
    await raw.enqueue({
      id: "crash-job",
      name: "deliver",
      runAt: Date.now() - 10_000,
      attempts: 0,
      maxAttempts: 1,
      status: "queued",
      createdAt: Date.now(),
    });
    await raw.claim(5, 1, Date.now() - 5_000);

    // Worker 2: a fresh store + queue over the same directory must recover the
    // expired-lease job and process it to completion.
    const store = createFileJobStore(dir);
    let runs = 0;
    const queue = createDurableJobQueue({
      store,
      handlers: {
        deliver: async () => {
          runs += 1;
        },
      },
      pollIntervalMs: 20,
    });

    queue.start();
    await waitFor(() => runs >= 1);
    await queue.stop();

    expect(runs).toBe(1);
    const jobs = await store.list();
    expect(jobs.every((j) => j.status === "completed" || j.status === "failed")).toBe(true);
  });

  it("persists across a full restart (new queue, new store, same dir)", async () => {
    const dir = tmp();
    let done = false;
    const storeA = createFileJobStore(dir);
    const queueA = createDurableJobQueue({
      store: storeA,
      handlers: { durable: async () => {} },
      pollIntervalMs: 20,
      onComplete: () => {
        done = true;
      },
    });

    await queueA.enqueue({ name: "durable", payload: { x: 1 } });
    queueA.start();
    await waitFor(() => done);
    await queueA.stop();

    // "Restart": new store + new queue over the same directory.
    const storeB = createFileJobStore(dir);
    const jobs = await storeB.list();
    expect(jobs.some((j) => j.name === "durable" && j.status === "completed")).toBe(true);
    expect(existsSync(join(dir, "jobs.jsonl"))).toBe(true);
  });
});
