import { describe, expect, test } from "bun:test";
import { InFlight } from "../src/cache/in-flight.ts";
import { QueryCache } from "../src/cache/query-cache.ts";
import { stableHash } from "../src/utils/hash.ts";

describe("QueryCache", () => {
  test("set/get roundtrip", () => {
    const cache = new QueryCache();
    const key = cache.key("users", stableHash([{ role: "admin" }]));
    cache.set(key, [1, 2, 3]);
    expect(cache.get(key)).toEqual([1, 2, 3]);
  });

  test("evicts beyond maxSize", () => {
    const cache = new QueryCache({ maxSize: 2 });
    const k1 = cache.key("a", "1");
    const k2 = cache.key("a", "2");
    const k3 = cache.key("a", "3");
    cache.set(k1, 1);
    cache.set(k2, 2);
    cache.set(k3, 3);
    expect(cache.get(k1)).toBeUndefined();
    expect(cache.get(k2)).toBe(2);
  });

  test("expires entries after TTL", async () => {
    const cache = new QueryCache({ ttlMs: 10 });
    const key = cache.key("a", "1");
    cache.set(key, "v");
    expect(cache.get(key)).toBe("v");
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get(key)).toBeUndefined();
  });

  test("invalidates by collection", () => {
    const cache = new QueryCache();
    const kUsers = cache.key("users", "1");
    const kOrders = cache.key("orders", "1");
    cache.set(kUsers, "u");
    cache.set(kOrders, "o");
    cache.invalidateByCollection("users");
    expect(cache.get(kUsers)).toBeUndefined();
    expect(cache.get(kOrders)).toBe("o");
  });

  test("set() with extra collections — a write to ANY source invalidates the entry", () => {
    const cache = new QueryCache();
    // A join aggregation cached under the primary ('orders') + a source ('customers').
    const key = cache.key("orders", "joined-1");
    cache.set(key, [{ _id: "o1" }], undefined, ["customers"]);
    expect(cache.get(key)).toEqual([{ _id: "o1" }]);
    // A write to the JOINED source drops the entry too.
    cache.invalidateByCollection("customers");
    expect(cache.get(key)).toBeUndefined();
    // And re-caching after invalidation works (stale cross-index refs are inert).
    cache.set(key, [{ _id: "o2" }], undefined, ["customers"]);
    expect(cache.get(key)).toEqual([{ _id: "o2" }]);
    cache.invalidateByCollection("orders");
    expect(cache.get(key)).toBeUndefined();
  });

  test("write-after-invalidate race: a late set with a stale version is never served", () => {
    const cache = new QueryCache();
    const key = cache.key("orders", "1");
    // A read captures the collection version, then a write invalidates while the
    // read is in-flight, then the read completes and tries to cache its result.
    const v0 = cache.versionOf("orders");
    cache.invalidateByCollection("orders"); // write lands mid-flight
    cache.set(key, "stale-by-arrival", undefined, undefined, { orders: v0 });
    // The stale result must NOT be served — the next read re-fetches.
    expect(cache.get(key)).toBeUndefined();
    // A fresh set with the CURRENT version is served normally.
    const v1 = cache.versionOf("orders");
    cache.set(key, "fresh", undefined, undefined, { orders: v1 });
    expect(cache.get(key)).toBe("fresh");
  });

  test("versions: an entry is stale when ANY source collection changed mid-flight", () => {
    const cache = new QueryCache();
    const key = cache.key("orders", "join-1");
    const ordersV = cache.versionOf("orders");
    const customersV = cache.versionOf("customers");
    // A write to the JOIN source bumps its version while the read is in-flight.
    cache.invalidateByCollection("customers");
    cache.set(key, "stale-join", undefined, ["customers"], {
      orders: ordersV,
      customers: customersV,
    });
    expect(cache.get(key)).toBeUndefined();
    // Both sources unchanged → served.
    const ordersV2 = cache.versionOf("orders");
    const customersV2 = cache.versionOf("customers");
    cache.set(key, "fresh-join", undefined, ["customers"], {
      orders: ordersV2,
      customers: customersV2,
    });
    expect(cache.get(key)).toBe("fresh-join");
  });

  test("versions: clear() also invalidates in-flight reads that set afterwards", () => {
    const cache = new QueryCache();
    cache.set(cache.key("orders", "1"), "warm");
    const v0 = cache.versionOf("orders");
    cache.clear(); // bumps known collection versions
    cache.set(cache.key("orders", "1"), "stale-after-clear", undefined, undefined, { orders: v0 });
    expect(cache.get(cache.key("orders", "1"))).toBeUndefined();
  });

  test("clear wipes everything", () => {
    const cache = new QueryCache();
    cache.set(cache.key("a", "1"), 1);
    cache.set(cache.key("b", "1"), 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  test("stats() reports hits/misses, evictions and lifecycle counters", () => {
    const cache = new QueryCache({ maxSize: 2 });
    expect(cache.stats()).toMatchObject({ size: 0, hits: 0, misses: 0, sets: 0, evictions: 0 });

    const k1 = cache.key("a", "1");
    const k2 = cache.key("a", "2");
    cache.set(k1, 1); // sets=1
    cache.get(k1); // hit
    cache.get(k2); // miss
    cache.set(k2, 2); // sets=2
    cache.set(cache.key("a", "3"), 3); // sets=3 → LRU evicts k1 (maxSize 2)
    expect(cache.stats()).toMatchObject({ size: 2, hits: 1, misses: 1, sets: 3, evictions: 1 });

    cache.invalidateByCollection("a"); // invalidateEvents=1 (keys existed)
    cache.invalidateByCollection("nope"); // no keys → not counted
    expect(cache.stats()).toMatchObject({ size: 0, invalidateEvents: 1, deletes: 0 });

    cache.clear();
    expect(cache.stats().clearEvents).toBe(1);
  });

  test("clone: true returns a fresh copy per read (mutation-isolated)", () => {
    const cache = new QueryCache({ clone: true });
    const key = cache.key("users", "1");
    cache.set(key, { _id: "1", tags: ["a"] });
    const first = cache.get(key) as { tags: string[] };
    first.tags.push("b"); // mutate the returned copy
    const second = cache.get(key) as { tags: string[] };
    expect(second.tags).toEqual(["a"]); // stored entry untouched
  });

  test("clone: false shares the same reference by default", () => {
    const cache = new QueryCache();
    const key = cache.key("users", "1");
    cache.set(key, { tags: ["a"] });
    const value = cache.get(key) as { tags: string[] };
    value.tags.push("b");
    expect((cache.get(key) as { tags: string[] }).tags).toEqual(["a", "b"]);
  });
});

describe("InFlight dedup", () => {
  test("coalesces identical keys", async () => {
    const inflight = new InFlight();
    let runs = 0;
    const run = () =>
      inflight.run("same", async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 5));
        return "ok";
      });
    const [a, b, c] = await Promise.all([run(), run(), run()]);
    expect(a).toBe("ok");
    expect(b).toBe("ok");
    expect(c).toBe("ok");
    expect(runs).toBe(1);
    expect(inflight.size).toBe(0);
  });

  test("different keys run independently", async () => {
    const inflight = new InFlight();
    const keys: string[] = [];
    const run = (k: string) => inflight.run(k, async () => keys.push(k));
    await Promise.all([run("a"), run("b")]);
    expect(keys.sort()).toEqual(["a", "b"]);
  });
});
