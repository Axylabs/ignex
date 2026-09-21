/**
 * @fileoverview Enterprise STABILITY regression suite.
 *
 * Pins the resource-lifecycle invariants a long-lived server depends on:
 *  - timers created by framework primitives (job queue, file-store coalescing,
 *    scheduler matcher) are released on teardown, so `stop()`/`close()` leave
 *    the event loop clean and a process can exit;
 *  - a failing background task surfaces through the app-facing `onError`
 *    sink and NEVER becomes an unhandled rejection;
 *  - SSE teardown swallows even a hostile generator `.return()`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileStore,
  createJobQueue,
  createMemoryStore,
  createScheduler,
  createStoreJobStore,
  sse,
} from "@ignex/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("job queue — rejection containment", () => {
  it("routes a failing task to onError and never leaks an unhandled rejection", async () => {
    const errors: unknown[] = [];
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const queue = createJobQueue({ onError: (error) => errors.push(error) });
      queue.enqueue("boom", () => {
        throw new Error("task failed");
      });
      await queue.stop();
      await flush();

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe("task failed");
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("file store — coalesced-write teardown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms one coalesce timer on set() and clears it on close() after flushing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ignex-filestore-"));
    vi.useFakeTimers();
    try {
      const store = createFileStore(dir, { writeCoalesceMs: 50, file: "s.jsonl" });
      store.set("k", { v: 1 });
      expect(vi.getTimerCount()).toBe(1); // pending coalesced rewrite

      store.close(); // flushes pending + clears the timer
      expect(vi.getTimerCount()).toBe(0);
      expect(store.get("k")).toEqual({ v: 1 }); // memory view intact after close
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scheduler — matcher timer teardown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases its tick timer on stop(), so the event loop can drain", () => {
    vi.useFakeTimers();
    const scheduler = createScheduler({
      store: createStoreJobStore(createMemoryStore()),
      log: () => {},
    });
    // The memory store arms its own sweep interval — that is the baseline.
    const baseline = vi.getTimerCount();
    scheduler.cron("* * * * * *", "secondly", async () => {}); // 6-field → matcher timer
    expect(vi.getTimerCount()).toBe(baseline + 1);

    scheduler.stop();
    expect(vi.getTimerCount()).toBe(baseline);
  });
});

describe("SSE — hostile generator teardown", () => {
  it("swallows a generator whose return() throws (no unhandled rejection, no throw)", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const generator = (async function* hostile(): AsyncGenerator<string> {
        yield "hello";
        throw new Error("never yielded");
      })();
      // Make teardown hostile: replace return() with a throwing one.
      (generator as unknown as { return: () => unknown }).return = () => {
        throw new Error("generator return() blew up");
      };

      const res = sse(generator);
      const body = res.body;
      expect(body).not.toBeNull();
      if (body !== null) await body.cancel(); // triggers stop() → return()

      await flush();
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
