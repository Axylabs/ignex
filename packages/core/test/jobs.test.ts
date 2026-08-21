/**
 * Job queue / scheduling edge cases — schedule cancel (incl. recurring
 * intervals), queued-job cancellation, timeout abort semantics and retries.
 */

import { describe, expect, it } from "vitest";
import { createJobQueue, withRetry, withTimeout } from "../src/index.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createJobQueue", () => {
  it("cancels a delayed scheduled job before it runs", async () => {
    const q = createJobQueue();
    let ran = false;
    const job = q.schedule(
      "x",
      () => {
        ran = true;
      },
      { delay: 30 },
    );
    job.cancel();
    await sleep(60);
    expect(ran).toBe(false);
    await q.stop();
  });

  it("cancels a recurring schedule job after it has started", async () => {
    const q = createJobQueue();
    let count = 0;
    const job = q.schedule(
      "x",
      () => {
        count += 1;
      },
      { delay: 5, interval: 15 },
    );

    // Let the initial delay pass and a few intervals fire.
    await sleep(50);
    expect(count).toBeGreaterThan(0);

    job.cancel();
    const snapshot = count;
    await sleep(50);
    expect(count).toBe(snapshot);
    await q.stop();
  });

  it("skips a queued job cancelled before it starts", async () => {
    const q = createJobQueue({ concurrency: 1 });
    let secondRan = false;

    const first = new Promise<void>((resolve) => {
      q.enqueue("first", async () => {
        await sleep(30);
        resolve();
      });
    });

    const second = q.enqueue("second", () => {
      secondRan = true;
    });

    second.cancel();
    await first;
    await sleep(20);

    expect(secondRan).toBe(false);
    expect(q.pending).toBe(0);
    await q.stop();
  });

  it("fails loud when enqueueing after stop (no silent drop)", async () => {
    const q = createJobQueue({ concurrency: 1 });
    let ran = false;
    q.enqueue("first", async () => {
      await sleep(20);
    });
    await sleep(5);
    await q.stop();
    // After stop() the queue is dead: enqueueing must throw, not silently
    // drop the job (a background job that never runs is a silent data-loss bug).
    expect(() =>
      q.enqueue("after-stop", () => {
        ran = true;
      }),
    ).toThrow(/stopped/);
    expect(ran).toBe(false);
  });

  it("fails loud when scheduling after stop", async () => {
    const q = createJobQueue();
    await q.stop();
    expect(() => q.schedule("late", () => {}, { delay: 5 })).toThrow(/stopped/);
    expect(() => q.every("late-every", 10, () => {})).toThrow(/stopped/);
    expect(() => q.once("late-once", new Date(Date.now() + 1000), () => {})).toThrow(/stopped/);
  });

  it("stop() resolves even when an in-flight task never completes (deadline)", async () => {
    const q = createJobQueue({ stopDeadlineMs: 60 });
    q.enqueue("stuck", () => new Promise<void>(() => {})); // never resolves
    while (q.running === 0) await sleep(5); // wait for it to start

    const started = Date.now();
    await q.stop();
    // Returns via the deadline, not by waiting forever.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("withTimeout", () => {
  it("rejects and aborts the underlying task on timeout", async () => {
    const run = withTimeout(20)((signal) => {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
        // Never resolves on its own.
      });
    });
    await expect(run()).rejects.toThrow(/timed out/);
  });

  it("resolves when the task completes in time", async () => {
    const run = withTimeout(100)(() => Promise.resolve("done"));
    await expect(run()).resolves.toBe("done");
  });
});

describe("withRetry", () => {
  it("retries with backoff then gives up", async () => {
    let attempts = 0;
    const run = withRetry(
      2,
      1,
    )(async () => {
      attempts += 1;
      throw new Error("boom");
    });
    await expect(run()).rejects.toThrow("boom");
    expect(attempts).toBe(3); // initial attempt + 2 retries
  });

  it("succeeds on a later attempt", async () => {
    let attempts = 0;
    const run = withRetry(
      3,
      1,
    )(async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("transient");
    });
    await expect(run()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
