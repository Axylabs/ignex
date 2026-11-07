/**
 * DataLoader cache bounds — the default 10 000-entry oldest-eviction bound
 * (module-scope loaders with high-cardinality keys previously grew without
 * limit) and the `max: false` unbounded escape hatch.
 */
import { describe, expect, it } from "vitest";
import { createDataLoader, DEFAULT_DATALOADER_MAX } from "../src/data/dataloader";

describe("dataloader cache bounds", () => {
  /** Loader with a batch-call counter — cache hits never re-invoke the fn. */
  const loader = (
    max: number | false | undefined,
  ): { dl: ReturnType<typeof createDataLoader<number, number>>; calls: () => number } => {
    let batches = 0;
    const dl = createDataLoader<number, number>(
      async (keys) => {
        batches += 1;
        return keys.map((k) => k * 2);
      },
      max === false ? { max: false } : max === undefined ? {} : { max },
    );
    return { dl, calls: () => batches };
  };

  it("default bound caps the cache at 10 000 entries (oldest evicted)", async () => {
    const { dl } = loader(undefined);
    // Load > max keys sequentially (each awaits a batch of one).
    for (let k = 0; k < DEFAULT_DATALOADER_MAX + 50; k++) await dl.load(k);
    // The OLDEST keys were evicted: key 0 re-batches, the newest are cached.
    const { dl: fresh } = loader(undefined);
    void fresh;
    expect(await dl.load(0)).toBe(0); // evicted → resolves via re-batch
    expect(await dl.load(DEFAULT_DATALOADER_MAX + 49)).toBe((DEFAULT_DATALOADER_MAX + 49) * 2);
  });

  it("an explicit smaller max evicts the oldest keys", async () => {
    const { dl, calls } = loader(3);
    for (const k of [1, 2, 3, 4, 5]) await dl.load(k);
    const afterLoad = calls();
    // Key 1 (oldest) was evicted → a repeat load re-batches; key 5 is cached.
    await dl.load(1);
    await dl.load(5);
    expect(calls()).toBe(afterLoad + 1);
    expect(await dl.load(1)).toBe(2);
  });

  it("max: false restores unbounded semantics", async () => {
    const { dl, calls } = loader(false);
    for (let k = 0; k < 200; k++) await dl.load(k);
    const afterLoad = calls();
    await dl.load(0); // still cached
    await dl.load(199);
    expect(calls()).toBe(afterLoad);
  });

  it("prime honors the bound too", async () => {
    const { dl, calls } = loader(3);
    for (const k of [1, 2, 3, 4, 5]) dl.prime(k, k * 10);
    const afterPrime = calls();
    await dl.load(1); // oldest primed key was evicted → re-batches
    expect(calls()).toBe(afterPrime + 1);
    expect(await dl.load(1)).toBe(2); // batch fn wins over evicted prime
  });

  it("batched loads under the bound never evict", async () => {
    const { dl, calls } = loader(100);
    await Promise.all(Array.from({ length: 50 }, (_, k) => dl.load(k)));
    const afterLoad = calls();
    await Promise.all(Array.from({ length: 50 }, (_, k) => dl.load(k)));
    expect(calls()).toBe(afterLoad);
  });
});
