import { describe, expect, test } from "bun:test";
import { DataLoader } from "../src/loader/dataloader.ts";

const mapOf = (keys: string[], fn: (k: string) => string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const k of keys) map.set(k, fn(k));
  return map;
};

describe("DataLoader batching", () => {
  test("coalesces concurrent loads into one batch call", async () => {
    let batchCalls = 0;
    const loader = new DataLoader<string, string>({
      batch: async (keys) => {
        batchCalls++;
        return mapOf(keys, (k) => k.toUpperCase());
      },
    });
    const results = await Promise.all([loader.load("a"), loader.load("b"), loader.load("c")]);
    expect(results).toEqual(["A", "B", "C"]);
    expect(batchCalls).toBe(1);
  });

  test("caches values so repeat loads skip the batch", async () => {
    let batchCalls = 0;
    const loader = new DataLoader<string, string>({
      batch: async (keys) => {
        batchCalls++;
        return mapOf(keys, (k) => k.toUpperCase());
      },
    });
    expect(await loader.load("x")).toBe("X");
    expect(await loader.load("x")).toBe("X");
    expect(batchCalls).toBe(1);
  });

  test("resolves missing keys as undefined", async () => {
    const loader = new DataLoader<string, string>({
      batch: async (keys) => {
        const map = new Map<string, string>();
        for (const k of keys) if (k.startsWith("present")) map.set(k, k);
        return map;
      },
    });
    expect(await loader.load("present")).toBe("present");
    expect(await loader.load("missing")).toBeUndefined();
  });

  test("rejects all pending when the batch throws", async () => {
    const loader = new DataLoader<string, string>({
      batch: async () => {
        throw new Error("boom");
      },
    });
    const p1 = loader.load("a");
    const p2 = loader.load("b");
    const results = await Promise.allSettled([p1, p2]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
  });

  test("a failed batch is NOT cached — a later load retries", async () => {
    let batchCalls = 0;
    const loader = new DataLoader<string, string>({
      batch: async () => {
        batchCalls++;
        throw new Error("boom");
      },
    });
    await expect(loader.load("a")).rejects.toThrow("boom");
    await expect(loader.load("a")).rejects.toThrow("boom");
    expect(batchCalls).toBe(2); // the failure was evicted, so the 2nd load re-ran
  });

  test("recovers when a later batch succeeds after a failure", async () => {
    let batchCalls = 0;
    const loader = new DataLoader<string, string>({
      batch: async (keys) => {
        batchCalls++;
        if (batchCalls === 1) throw new Error("boom");
        return mapOf(keys, (k) => k.toUpperCase());
      },
    });
    await expect(loader.load("a")).rejects.toThrow("boom");
    expect(await loader.load("a")).toBe("A"); // fresh batch after eviction
    expect(batchCalls).toBe(2);
  });

  test("evicting a failed batch does not clobber a key cleared & re-loaded mid-flight", async () => {
    let batchCalls = 0;
    let re: Promise<string | undefined> | undefined;
    const loader = new DataLoader<string, string>({
      batch: async (keys) => {
        batchCalls++;
        if (batchCalls === 1) {
          loader.clear("a"); // drop the cached P1
          re = loader.load("a"); // P2 — must survive the eviction below
          await Promise.resolve();
          throw new Error("boom");
        }
        return mapOf(keys, (k) => k.toUpperCase());
      },
    });

    const first = loader.load("a"); // P1
    await expect(first).rejects.toThrow("boom");

    // Eviction must be identity-guarded: P2 was queued mid-flight and should
    // resolve from a fresh batch instead of being wiped with P1.
    expect(await re).toBe("A");
    expect(batchCalls).toBe(2); // P1's failed batch + P2's successful batch
  });

  test("splits oversized batches by maxBatchSize", async () => {
    const received: string[][] = [];
    const loader = new DataLoader<string, string>({
      maxBatchSize: 2,
      batch: async (keys) => {
        received.push([...keys]);
        return mapOf(keys, (k) => k);
      },
    });
    const results = await Promise.all(["a", "b", "c", "d", "e"].map((k) => loader.load(k)));
    expect(results).toEqual(["a", "b", "c", "d", "e"]);
    expect(received).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  test("loadMany resolves per key", async () => {
    const loader = new DataLoader<string, string>({
      batch: async (keys) => mapOf(keys, (k) => k + "!"),
    });
    expect(await loader.loadMany(["a", "b"])).toEqual(["a!", "b!"]);
  });

  test("prime + clear control the cache", async () => {
    let batchCalls = 0;
    const loader = new DataLoader<string, string>({
      batch: async (keys) => {
        batchCalls++;
        return mapOf(keys, (k) => k);
      },
    });
    loader.prime("z", "primed");
    expect(await loader.load("z")).toBe("primed");
    expect(batchCalls).toBe(0);
    loader.clear("z");
    expect(await loader.load("z")).toBe("z");
    expect(batchCalls).toBe(1);
  });

  test("supports value-based keys (ObjectId-style) via keyOf", async () => {
    const ids = [
      { toHexString: () => "abc123" },
      { toHexString: () => "def456" },
      { toHexString: () => "abc123" }, // same hex as first
    ];
    let batchCalls = 0;
    const loader = new DataLoader<{ toHexString(): string }, string>({
      keyOf: (k) => k.toHexString(),
      batch: async (keys) => {
        batchCalls++;
        const map = new Map<{ toHexString(): string }, string>();
        for (const k of keys) map.set(k, `row:${k.toHexString()}`);
        return map;
      },
    });
    const [r1, r2] = await Promise.all([loader.load(ids[0]!), loader.load(ids[2]!)]);
    expect(r1).toBe("row:abc123");
    expect(r2).toBe("row:abc123"); // same canonical key → shared cache entry
    expect(batchCalls).toBe(1);
  });
});
