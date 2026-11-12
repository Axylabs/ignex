/**
 * Adaptive DataLoader batch limits, sampled timing, and runtime statistics.
 */
import { describe, expect, it } from "vitest";
import { createDataLoader } from "../src/data/dataloader";

describe("adaptive DataLoader", () => {
  it("grows a saturated fast batch while preserving output order and duplicates", async () => {
    let now = 0;
    const batches: number[] = [];
    const loader = createDataLoader<number, number>(
      async (keys) => {
        batches.push(keys.length);
        now += 100_000;
        return keys.map((key) => key * 2);
      },
      {
        adaptive: {
          minBatchSize: 4,
          maxBatchSize: 16,
          targetBatchMs: 1,
          sampleEvery: 1,
          ewmaAlpha: 1,
          nowNs: () => now,
        },
      },
    );

    expect(loader.stats.batchSize).toBe(4);
    const values = await loader.loadMany([1, 2, 2, 3, 4]);
    expect(values).toEqual([2, 4, 4, 6, 8]);
    expect(batches).toEqual([4]);
    expect(loader.stats).toMatchObject({
      items: 5,
      batches: 1,
      batchSize: 8,
      averageBatchMs: 0.1,
      samples: 1,
      pending: 0,
    });
  });

  it("shrinks after slow batches and respects the minimum", async () => {
    let now = 0;
    const loader = createDataLoader<number, number>(
      async (keys) => {
        now += 2_000_000;
        return keys;
      },
      {
        adaptive: {
          minBatchSize: 2,
          maxBatchSize: 8,
          initialBatchSize: 8,
          targetBatchMs: 1,
          sampleEvery: 1,
          ewmaAlpha: 1,
          nowNs: () => now,
        },
      },
    );

    await loader.loadMany([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(loader.stats.batchSize).toBe(4);
    await loader.loadMany([9, 10, 11, 12]);
    expect(loader.stats.batchSize).toBe(2);
    await loader.loadMany([13, 14]);
    expect(loader.stats.batchSize).toBe(2);
  });

  it("treats maxBatchSize as a hard cap for adaptive growth", async () => {
    let now = 0;
    const loader = createDataLoader<number, number>(
      async (keys) => {
        now += 1000;
        return keys;
      },
      {
        maxBatchSize: 3,
        adaptive: {
          minBatchSize: 1,
          initialBatchSize: 16,
          sampleEvery: 1,
          nowNs: () => now,
        },
      },
    );

    const values = await loader.loadMany([1, 2, 3, 4, 5, 6, 7]);
    expect(values).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(loader.stats.batchSize).toBe(3);
  });

  it("samples failed batches without changing rejection behavior", async () => {
    let now = 0;
    const loader = createDataLoader<number, number>(
      async () => {
        now += 3_000_000;
        throw new Error("database unavailable");
      },
      {
        adaptive: { minBatchSize: 2, sampleEvery: 1, nowNs: () => now },
      },
    );

    const results = await Promise.allSettled([loader.load(1), loader.load(2)]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(loader.stats).toMatchObject({ batches: 1, samples: 1, averageBatchMs: 3 });
  });
});

describe("DataLoader stats without adaptation", () => {
  it("reports pending work, batches, items, and cache hits without timing calls", async () => {
    const loader = createDataLoader<number, number>(async (keys) => keys);
    const first = loader.load(1);
    const second = loader.load(2);
    expect(loader.stats).toMatchObject({
      items: 2,
      batches: 0,
      pending: 2,
      batchSize: Number.POSITIVE_INFINITY,
      averageBatchMs: 0,
      samples: 0,
    });

    await Promise.all([first, second]);
    await loader.load(1);
    expect(loader.stats).toMatchObject({ items: 3, batches: 1, cacheHits: 1, pending: 0 });
  });
});
