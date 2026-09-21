/**
 * @fileoverview Enterprise SCALABILITY regression suite.
 *
 * Pins the invariants a server under load depends on:
 *  - concurrent job `claim`s across workers never hand the SAME job to two
 *    claimers (no double-claim through a shared store);
 *  - the DataLoader coalesces N concurrent `load()` calls into exactly one
 *    batch, and independent loaders NEVER share a batch;
 *  - rate-limit state stays bounded by `storeMax` regardless of distinct-key
 *    cardinality (an evicted key gets a fresh window — memory cannot grow
 *    without bound);
 *  - the file store's coalesced rewrites amortize disk writes below mutation
 *    count and flush exactly-once on `close()`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApp,
  createDataLoader,
  createFileStore,
  createStoreJobStore,
  LRUCache,
  rateLimit,
} from "@ignex/core";
import { describe, expect, it, vi } from "vitest";

const req = (ip: string, path = "/"): Request =>
  new Request(`http://localhost${path}`, {
    headers: { "x-forwarded-for": ip },
  });

/** App with the fixed-window limiter, trustProxy keyed by the x-forwarded-for IP. */
const createRateLimiterApp = (storeMax: number) =>
  createApp({
    plugins: [
      rateLimit({
        windowMs: 60_000,
        maxRequests: 1,
        storeMax,
        trustProxy: true,
      }),
    ],
    handler: () => new Response("ok"),
  });

/** Simulates a serialized sync durable backend (file/sqlite-style): every read
 * rehydrates a FRESH deep clone, so the read-modify-write race in concurrent
 * `claim()` calls is real and deterministic (the plain memory store masks it
 * by aliasing shared object references across reads — see `jobsFromRaw`). */
const createFreshReadStore = () => {
  let raw: unknown = null;
  return {
    get: (): unknown => (raw === null ? null : (JSON.parse(JSON.stringify(raw)) as unknown)),
    set: (_key: string, value: unknown): void => {
      raw = value;
    },
    delete: (): void => {
      raw = null;
    },
    touch: (): void => {},
  };
};

describe("job store — concurrent claim safety", () => {
  it("hands each due job to exactly ONE claimer under 100 parallel claims", async () => {
    // Fresh-read backend: the in-process memory store masks this race by
    // aliasing shared job references across reads (see jobsFromRaw), so the
    // real double-claim surface only appears when reads produce new objects.
    const store = createStoreJobStore(createFreshReadStore());
    const now = Date.now();
    for (let i = 0; i < 100; i++) {
      await store.enqueue({
        id: `job-${i}`,
        name: `n-${i}`,
        payload: null,
        status: "queued",
        runAt: now,
        attempts: 0,
        maxAttempts: 1,
        createdAt: now,
      });
    }

    // 100 workers racing a `claim(1)` each — the classic double-claim storm.
    const claimed = await Promise.all(
      Array.from({ length: 100 }, () => store.claim(1, 30_000, now)),
    );
    const ids = claimed.flatMap((list) => list.map((job) => job.id));
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100); // zero double-claims

    // The backend reflects the same truth: every job claimed exactly once.
    const all = await store.list();
    const running = all.filter((job) => job.status === "running");
    expect(running).toHaveLength(100);
    const owners = new Set(running.map((job) => job.leaseOwner));
    expect(owners.size).toBe(100);
  });
});

describe("rate limiting — bounded memory under many distinct keys", () => {
  it("rateLimit: a storeMax-bounded store evicts and re-allows old keys (no unbounded growth)", async () => {
    const app = createRateLimiterApp(32);
    for (let i = 0; i < 50_000; i++) {
      const res = await app.handler(req(`client-${i}.x`));
      expect(res.status).toBe(200); // fresh windows as keys rotate in
    }
    // First key was evicted long ago (50k >> 32) — it gets a fresh window,
    // not a stale 429 from a never-shrinking store.
    const revisit = await app.handler(req("client-0.x"));
    expect(revisit.status).toBe(200);
  });

  it("LRUCache (the plugin's state store): size never exceeds max under 50k inserts", () => {
    const cache = new LRUCache<string, number>({ max: 1024 });
    for (let i = 0; i < 50_000; i++) cache.set(`key-${i}`, i);
    expect(cache.size).toBeLessThanOrEqual(1024);
  });
});

describe("file store — coalesced rewrites", () => {
  it("500 rapid sets produce no disk writes until close() flushes exactly once", () => {
    const dir = mkdtempSync(join(tmpdir(), "ignex-filestore-scale-"));
    try {
      const store = createFileStore(dir, { writeCoalesceMs: 50_000, file: "s.jsonl" });
      for (let i = 0; i < 500; i++) store.set(`k-${i}`, { i });

      // Mid-burst: nothing hit the disk yet (writes coalesced into the timer);
      // the file may not even exist yet.
      const midBurst = (() => {
        try {
          return readFileSync(join(dir, "s.jsonl"), "utf8");
        } catch {
          return "";
        }
      })();
      expect(midBurst).toBe("");

      store.close(); // flush the pending rewrite
      const lines = readFileSync(join(dir, "s.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(lines).toHaveLength(500); // one durable write, all data present
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DataLoader — batching", () => {
  it("coalesces 50 concurrent load() calls into exactly one batch", async () => {
    const batch = vi.fn(async (keys: string[]) => keys.map((key) => key.toUpperCase()));
    const loader = createDataLoader(batch);
    const keys = Array.from({ length: 50 }, (_, i) => `k${i}`);
    const values = await Promise.all(keys.map((key) => loader.load(key)));
    expect(values).toHaveLength(50);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]).toEqual([keys]);
  });

  it("never merges batches across independent loaders (per-request isolation)", async () => {
    const batchA = vi.fn(async (keys: string[]) => keys.map((key) => `A:${key}`));
    const batchB = vi.fn(async (keys: string[]) => keys.map((key) => `B:${key}`));
    const a = createDataLoader(batchA);
    const b = createDataLoader(batchB);
    const [va, vb] = await Promise.all([a.load("x"), b.load("y")]);
    expect(va).toBe("A:x");
    expect(vb).toBe("B:y");
    expect(batchA).toHaveBeenCalledTimes(1);
    expect(batchA.mock.calls[0]).toEqual([["x"]]);
    expect(batchB).toHaveBeenCalledTimes(1);
    expect(batchB.mock.calls[0]).toEqual([["y"]]);
    // Two DIFFERENT keys in one batch would be cross-request bleed.
    expect(batchA.mock.calls[0]?.[0]).not.toContain("y");
    expect(batchB.mock.calls[0]?.[0]).not.toContain("x");
  });
});
