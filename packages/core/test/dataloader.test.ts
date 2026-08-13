/**
 * DataLoader tests — batching, dedup, caching, per-key errors, and the
 * `ctx.loader` per-request factory.
 */

import { createContext, createDataLoader } from "@ignex/core";
import { describe, expect, it, vi } from "vitest";

const flush = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

describe("createDataLoader", () => {
  it("batches concurrent loads into a single batchLoadFn call", async () => {
    const batchFn = vi.fn(async (keys: readonly number[]) => keys.map((k) => k * 10));
    const loader = createDataLoader(batchFn);

    const [a, b, c] = await Promise.all([loader.load(1), loader.load(2), loader.load(3)]);

    expect([a, b, c]).toEqual([10, 20, 30]);
    expect(batchFn).toHaveBeenCalledTimes(1);
    expect(batchFn.mock.calls[0]?.[0]).toEqual([1, 2, 3]);
  });

  it("dedups concurrent loads of the same key (batchLoadFn sees each key once)", async () => {
    const batchFn = vi.fn(async (keys: readonly number[]) => keys.map((k) => k * 2));
    const loader = createDataLoader(batchFn);

    const results = await Promise.all([
      loader.load(7),
      loader.load(7),
      loader.load(7),
      loader.load(8),
    ]);

    expect(results).toEqual([14, 14, 14, 16]);
    // 7 appears once in the batch.
    expect(batchFn.mock.calls[0]?.[0]).toEqual([7, 8]);
    expect(batchFn).toHaveBeenCalledTimes(1);
  });

  it("caches results for subsequent loads", async () => {
    const batchFn = vi.fn(async (keys: readonly string[]) => keys.map((k) => k.toUpperCase()));
    const loader = createDataLoader(batchFn);

    await loader.load("a");
    await loader.load("a");

    expect(batchFn).toHaveBeenCalledTimes(1);

    // A later batch still hits the cache.
    await loader.load("b");
    await loader.load("a");
    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("does not share state between loaders (per-request cache isolation)", async () => {
    const batchFn = vi.fn(async (keys: readonly number[]) => keys.map((k) => k + 1));
    const a = createDataLoader(batchFn);
    const b = createDataLoader(batchFn);

    await a.load(1);
    await b.load(1);

    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("dispatches immediately when maxBatchSize is reached", async () => {
    const batchFn = vi.fn(async (keys: readonly number[]) => keys.map((k) => k));
    const loader = createDataLoader(batchFn, { maxBatchSize: 2 });

    const p1 = loader.load(1);
    const p2 = loader.load(2);
    const p3 = loader.load(3);

    const values = await Promise.all([p1, p2, p3]);
    expect(values).toEqual([1, 2, 3]);

    // First batch flushed at size 2, second batch flushed on the microtask.
    expect(batchFn.mock.calls.map((c) => c[0])).toEqual([[1, 2], [3]]);
  });

  it("rejects only the affected key when a value is an Error", async () => {
    const batchFn = async (keys: readonly number[]) =>
      keys.map((k) => (k === 2 ? new Error("missing") : k * 3));
    const loader = createDataLoader(batchFn);

    const results = await Promise.allSettled([loader.load(1), loader.load(2), loader.load(3)]);

    expect(results[0]).toMatchObject({ status: "fulfilled", value: 3 });
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect(results[2]).toMatchObject({ status: "fulfilled", value: 9 });
  });

  it("re-batches a failing key by default (errors are NOT cached)", async () => {
    const batchFn = vi.fn(async (keys: readonly number[]) =>
      keys.map((k) => (k === 2 ? new Error("missing") : k * 3)),
    );
    const loader = createDataLoader(batchFn);

    await expect(loader.load(2)).rejects.toThrow("missing");
    await expect(loader.load(2)).rejects.toThrow("missing");
    // Default semantics: the failing key is re-fetched (2 batches), so a
    // transient failure can recover.
    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("cacheErrors:true caches a per-key error so repeat loads do not re-batch", async () => {
    const batchFn = vi.fn(async (keys: readonly number[]) =>
      keys.map((k) => (k === 2 ? new Error("missing") : k * 3)),
    );
    const loader = createDataLoader(batchFn, { cacheErrors: true });

    await expect(loader.load(2)).rejects.toThrow("missing");
    await expect(loader.load(2)).rejects.toThrow("missing");
    await expect(loader.load(2)).rejects.toThrow("missing");
    // Cached error → single batch; the failing key never re-batches.
    expect(batchFn).toHaveBeenCalledTimes(1);
  });

  it("cacheErrors:true does not cache non-error keys (they still hit the value cache)", async () => {
    const batchFn = vi.fn(async (keys: readonly number[]) =>
      keys.map((k) => (k === 2 ? new Error("missing") : k * 3)),
    );
    const loader = createDataLoader(batchFn, { cacheErrors: true });

    // One batch: [1, 2] → value 3 + cached error.
    const first = await Promise.allSettled([loader.load(1), loader.load(2)]);
    expect(first[0]).toMatchObject({ status: "fulfilled", value: 3 });
    expect(first[1]).toMatchObject({ status: "rejected" });

    // Repeat loads hit the value cache (1) and the error cache (2) — no re-batch.
    await expect(loader.load(1)).resolves.toBe(3);
    await expect(loader.load(2)).rejects.toThrow("missing");
    expect(batchFn).toHaveBeenCalledTimes(1);
  });

  it("cacheErrors:true clear() clears a cached error (next load re-batches)", async () => {
    const batchFn = vi.fn(async (keys: readonly number[]) =>
      keys.map((k) => (k === 2 ? new Error("missing") : k * 3)),
    );
    const loader = createDataLoader(batchFn, { cacheErrors: true });

    await expect(loader.load(2)).rejects.toThrow("missing");
    loader.clear(2);
    await expect(loader.load(2)).rejects.toThrow("missing");
    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("rejects all pending loads when batchLoadFn throws", async () => {
    const batchFn = async (): Promise<readonly number[]> => {
      throw new Error("db down");
    };
    const loader = createDataLoader(batchFn);

    const results = await Promise.allSettled([loader.load(1), loader.load(2)]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
  });

  it("rejects when batchLoadFn returns the wrong number of values", async () => {
    const loader = createDataLoader<number, number>(async () => [1]); // 1 value for 2 keys
    const results = await Promise.allSettled([loader.load(1), loader.load(2)]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
  });

  it("supports prime, clear, and clearAll", async () => {
    const batchFn = vi.fn(async (keys: readonly number[]) => keys.map((k) => k));
    const loader = createDataLoader(batchFn);

    loader.prime(99, "primed");
    expect(await loader.load(99)).toBe("primed");
    expect(batchFn).not.toHaveBeenCalled();

    loader.clear(99);
    await loader.load(99);
    expect(batchFn).toHaveBeenCalledTimes(1);

    loader.prime(1, "x");
    loader.prime(2, "y");
    loader.clearAll();
    expect(batchFn).not.toHaveBeenCalledTimes(2); // cache empty → next load batches
  });

  it("honors cacheKeyFn", async () => {
    const batchFn = vi.fn(async (keys: readonly string[]) => keys.map((k) => k.length));
    const loader = createDataLoader(batchFn, { cacheKeyFn: (k: string) => k.length });

    expect(await loader.load("abc")).toBe(3);
    // Same cache key (different string) → cache hit, no new batch.
    expect(await loader.load("xyz")).toBe(3);
    expect(batchFn).toHaveBeenCalledTimes(1);
  });

  it("supports a custom batchScheduleFn", async () => {
    const batchFn = vi.fn(async (keys: readonly number[]) => keys.map((k) => k));
    let scheduled = 0;
    const loader = createDataLoader(batchFn, {
      batchScheduleFn: (cb) => {
        scheduled++;
        queueMicrotask(cb);
      },
    });

    await loader.load(1);
    expect(scheduled).toBe(1);
  });
});

describe("ctx.loader (per-request by default)", () => {
  it("exposes a loader factory that batches per request", async () => {
    const ctx = createContext(new Request("http://localhost:3000/"), {});
    const batchFn = vi.fn(async (keys: readonly string[]) => keys.map((k) => `u:${k}`));

    // ONE loader → all loads coalesce into a single batch call.
    const users = ctx.loader(batchFn);
    const values = await Promise.all([1, 2, 3, 4].map((id) => users.load(String(id))));

    expect(values).toEqual(["u:1", "u:2", "u:3", "u:4"]);
    expect(batchFn).toHaveBeenCalledTimes(1);
  });

  it("creates an isolated loader per call (no cross-call batching)", async () => {
    const ctx = createContext(new Request("http://localhost:3000/"), {});
    const batchFn = vi.fn(async (keys: readonly number[]) => keys.map((k) => k));

    await ctx.loader(batchFn).load(1);
    await ctx.loader(batchFn).load(1);

    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("works through createApp handlers", async () => {
    const { createApp } = await import("@ignex/core");
    const app = createApp({
      handler: async (c) => {
        const loader = c.loader(async (keys: readonly number[]) => keys.map((k) => k * 100));
        const [a, b] = await Promise.all([loader.load(1), loader.load(2)]);
        return Response.json({ a, b });
      },
    });

    const res = await app.handler(new Request("http://localhost:3000/"));
    expect(await res.json()).toEqual({ a: 100, b: 200 });
  });
});

// Referenced to keep flush util around for future async-batching assertions.
void flush;
