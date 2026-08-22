/**
 * HotCache tests — the global, opt-in read-through LRU cache.
 *
 * Pure-unit tests cover the LRU/read-through behavior (no Mongo). The
 * standalone ticker tests force `probe: false` and assert the global ticker
 * background-refreshes cached entries. The replica change-stream test is
 * guarded by the local Mongo probe AND skips unless the server is actually a
 * replica set (change streams require one) — see `tests/helpers.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "mongodb";
import { createHotCache } from "../src/cache/hot-cache/index.ts";
import { BadRequest } from "../src/errors/index.ts";
import type { LoggerLike } from "../src/utils/logger.ts";
import { sleep } from "../src/utils/timeout.ts";
import {
  closeService,
  makeEnterpriseService,
  maybeDescribe,
  noopLogger,
  probe,
  probeReplica,
} from "./helpers.ts";

describe("HotCache — read-through LRU", () => {
  test("serves from LRU after the first load (loader runs once per param set)", async () => {
    const hot = createHotCache();
    let loads = 0;
    const q = hot.register("echo", {
      loader: async (x: number) => {
        loads++;
        return x * 2;
      },
    });
    expect(await q.get(21)).toBe(42);
    expect(await q.get(21)).toBe(42);
    expect(loads).toBe(1);
  });

  test("different parameters produce distinct entries", async () => {
    const hot = createHotCache();
    let loads = 0;
    const q = hot.register("echo", {
      loader: async (x: number) => {
        loads++;
        return x * 2;
      },
    });
    expect(await q.get(1)).toBe(2);
    expect(await q.get(2)).toBe(4);
    expect(loads).toBe(2);
    expect(await q.get(1)).toBe(2);
    expect(loads).toBe(2);
  });

  test("keyOf lets callers choose which parameters form the cache key", async () => {
    const hot = createHotCache();
    let loads = 0;
    const q = hot.register("sum", {
      keyOf: (a: number) => String(a),
      loader: async (a: number, b: number) => {
        loads++;
        return a + b;
      },
    });
    expect(await q.get(1, 10)).toBe(11);
    expect(await q.get(1, 99)).toBe(11); // same key → cached
    expect(loads).toBe(1);
  });

  test("get() on an unregistered query throws BadRequest", async () => {
    const hot = createHotCache();
    await expect(hot.get("nope")).rejects.toBeInstanceOf(BadRequest);
  });

  test("registering the same name twice throws BadRequest", () => {
    const hot = createHotCache();
    hot.register("a", { loader: async () => 1 });
    expect(() => hot.register("a", { loader: async () => 2 })).toThrow(BadRequest);
  });

  test("ttl expires entries", async () => {
    const hot = createHotCache();
    let loads = 0;
    const q = hot.register("ttl", {
      ttlMs: 10,
      loader: async (x: number) => {
        loads++;
        return x;
      },
    });
    await q.get(1);
    await q.get(1);
    expect(loads).toBe(1);
    await sleep(30);
    await q.get(1);
    expect(loads).toBe(2);
  });

  test("maxSize evicts least-recently-used entries", async () => {
    const hot = createHotCache();
    let loads = 0;
    const q = hot.register("evict", {
      maxSize: 2,
      loader: async (x: number) => {
        loads++;
        return x;
      },
    });
    await q.get(1);
    await q.get(2);
    await q.get(3); // evicts 1 → {2,3}
    expect(loads).toBe(3);
    await q.get(2); // still cached (2 was never evicted)
    expect(loads).toBe(3);
    await q.get(1); // was evicted → reload
    expect(loads).toBe(4);
    // LRU capacity evictions are surfaced via stats().
    expect(hot.stats().perQuery.evict!.evictions).toBeGreaterThanOrEqual(1);
  });

  test("concurrent identical reads are in-flight deduped (loader runs once)", async () => {
    const hot = createHotCache();
    let loads = 0;
    const q = hot.register("dedupe", {
      loader: async (x: number) => {
        loads++;
        await sleep(20);
        return x;
      },
    });
    const [a, b, c] = await Promise.all([q.get(7), q.get(7), q.get(7)]);
    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(c).toBe(7);
    expect(loads).toBe(1);
  });

  test("loader errors are not cached — the next read retries", async () => {
    const hot = createHotCache();
    let loads = 0;
    const q = hot.register("flaky", {
      loader: async () => {
        loads++;
        if (loads === 1) throw new Error("boom");
        return "ok";
      },
    });
    await expect(q.get()).rejects.toThrow("boom");
    expect(loads).toBe(1);
    expect(await q.get()).toBe("ok");
    expect(loads).toBe(2);
  });

  test("invalidate() and clear() drop entries", async () => {
    const hot = createHotCache();
    const qa = hot.register("a", { loader: async () => "a" });
    const qb = hot.register("b", { loader: async () => "b" });
    await qa.get();
    await qb.get();
    expect(hot.size).toBe(2);
    qa.invalidate();
    expect(hot.size).toBe(1);
    await qa.get();
    expect(hot.size).toBe(2);
    hot.clear();
    expect(hot.size).toBe(0);
  });

  test("invalidateCollection clears only watch-bound queries", async () => {
    const hot = createHotCache();
    const fakeDb = { databaseName: "app" } as unknown as Db;
    let loads = 0;
    const bound = hot.register("bound", {
      watch: [{ db: fakeDb, collection: "products" }],
      loader: async () => {
        loads++;
        return loads;
      },
    });
    const free = hot.register("free", { loader: async () => "free" });
    await bound.get();
    await free.get();
    expect(hot.size).toBe(2);
    hot.invalidateCollection("products");
    expect(hot.size).toBe(1); // only `bound` cleared
    expect(await bound.get()).toBe(2); // reloaded
    expect(loads).toBe(2);
    expect(hot.size).toBe(2);
    await free.get(); // untouched
    expect(hot.size).toBe(2);
  });

  test("manual param-level invalidate drops only that entry", async () => {
    const hot = createHotCache();
    let loads = 0;
    const q = hot.register("sum", {
      loader: async (a: number, b: number) => {
        loads++;
        return a + b;
      },
    });
    await q.get(1, 2); // 3
    await q.get(5, 5); // 10
    expect(loads).toBe(2);
    q.invalidate(1, 2); // drop only the (1,2) entry
    expect(await q.get(1, 2)).toBe(3); // reloaded
    expect(loads).toBe(3);
    expect(await q.get(5, 5)).toBe(10); // still cached
    expect(loads).toBe(3);
    q.invalidate(); // drop everything
    expect(await q.get(5, 5)).toBe(10);
    expect(loads).toBe(4);
  });

  test("invalidateParams() and has() on the instance", async () => {
    const hot = createHotCache();
    let loads = 0;
    hot.register("echo", {
      keyOf: (x: number) => `k:${x}`,
      loader: async (x: number) => {
        loads++;
        return x;
      },
    });
    expect(hot.has("echo")).toBe(true);
    expect(hot.has("nope")).toBe(false);
    await hot.get("echo", 1);
    await hot.get("echo", 2);
    expect(loads).toBe(2);
    hot.invalidateParams("echo", 1); // keyOf computes `k:1` — same key as get
    expect(await hot.get("echo", 1)).toBe(1);
    expect(loads).toBe(3);
    expect(await hot.get("echo", 2)).toBe(2); // unaffected
    expect(loads).toBe(3);
  });

  test("an invalidation during an in-flight load prevents the stale result from being cached", async () => {
    const hot = createHotCache();
    let loads = 0;
    let releaseFirst!: () => void;
    const q = hot.register("race", {
      loader: async () => {
        loads++;
        if (loads === 1) {
          // Gate only the FIRST call so the follow-up get() can resolve.
          await new Promise<void>((r) => (releaseFirst = r));
        }
        return "value"; // first call's snapshot is taken before the invalidation
      },
    });
    const pending = q.get(); // miss → first loader in flight
    await sleep(5);
    q.invalidate(); // clears (empty) cache + bumps the generation
    releaseFirst(); // in-flight first load resolves AFTER the invalidation
    expect(await pending).toBe("value"); // caller still gets the value
    // The stale-by-arrival result must NOT have been cached — a fresh get re-runs.
    expect(await q.get()).toBe("value");
    expect(loads).toBe(2); // without the guard this would be a stale cache hit (1)
    await hot.stop();
  });

  test("invalidateParams during an in-flight load also prevents the stale write", async () => {
    const hot = createHotCache();
    let loads = 0;
    let releaseFirst!: () => void;
    const q = hot.register("race-param", {
      loader: async (x: number) => {
        loads++;
        if (loads === 1) await new Promise<void>((r) => (releaseFirst = r));
        return x;
      },
    });
    const pending = q.get(9);
    await sleep(5);
    q.invalidate(9); // param-level invalidation bumps the generation too
    releaseFirst();
    expect(await pending).toBe(9);
    expect(await q.get(9)).toBe(9);
    expect(loads).toBe(2);
    await hot.stop();
  });

  test("stats() reports per-query counters and sizes", async () => {
    const hot = createHotCache({ probe: async () => false });
    const q = hot.register("stats-q", {
      loader: async (x: string) => x,
    });
    await hot.start();
    await q.get("a"); // miss
    await q.get("a"); // hit
    await q.get("b"); // miss
    const s = hot.stats();
    expect(s.queries).toBe(1);
    expect(s.entries).toBe(2);
    expect(s.perQuery["stats-q"]).toMatchObject({ size: 2, hits: 1, misses: 2 });
    await hot.stop();
  });

  test("maxValueBytes skips caching oversized values (still returned)", async () => {
    const warns: string[] = [];
    const logger: LoggerLike = {
      debug() {},
      info() {},
      warn(_a: unknown, b?: string) {
        if (b) warns.push(b);
      },
      error() {},
    };
    let loads = 0;
    const hot = createHotCache({ probe: async () => false, logger });
    const q = hot.register("big", {
      maxValueBytes: 10,
      loader: async () => {
        loads++;
        return "this is a long string way over 10 bytes";
      },
    });
    expect(await q.get()).toBe("this is a long string way over 10 bytes");
    expect(await q.get()).toBe("this is a long string way over 10 bytes");
    expect(loads).toBe(2); // never cached → every read re-loads
    expect(warns.some((m) => m.includes("exceeds maxValueBytes"))).toBe(true);
    const s = hot.stats().perQuery.big!;
    expect(s.size).toBe(0);
    expect(s.sizeSkips).toBeGreaterThanOrEqual(1);
    await hot.stop();
  });
});

describe("HotCache — standalone ticker (probe: false)", () => {
  test("mode resolves to standalone when the probe reports no replicas", async () => {
    const hot = createHotCache({ probe: async () => false });
    await hot.start();
    expect(hot.mode).toBe("standalone");
    await hot.stop();
  });

  test("autoRefresh: false disables the ticker — manual invalidation only", async () => {
    let stock = 1;
    let loads = 0;
    const hot = createHotCache({
      probe: async () => false,
      autoRefresh: false,
      tickIntervalMs: 15,
    });
    const q = hot.register("stock", {
      refreshIntervalMs: 10,
      loader: async () => {
        loads++;
        return stock;
      },
    });
    await hot.start();
    expect(hot.mode).toBe("standalone");
    expect(hot.autoRefresh).toBe(false);
    expect(await q.get()).toBe(1);
    expect(loads).toBe(1);
    stock = 2;
    await sleep(80); // no ticker → no background refetch
    expect(await q.get()).toBe(1); // stale, not refreshed
    expect(loads).toBe(1);
    q.invalidate(); // manual invalidation drops it
    expect(await q.get()).toBe(2); // reloaded fresh
    expect(loads).toBe(2);
    await hot.stop();
  });

  test("the global ticker background-refreshes entries at refreshIntervalMs", async () => {
    let stock = 1;
    const hot = createHotCache({ probe: async () => false, tickIntervalMs: 15 });
    const q = hot.register("stock", {
      refreshIntervalMs: 10,
      loader: async () => stock,
    });
    await hot.start();
    expect(await q.get()).toBe(1);
    stock = 2; // external change — no invalidation hook exists on standalone
    expect(await q.get()).toBe(1); // still stale until a tick refreshes
    await sleep(90); // let the ticker swap in the fresh value
    expect(await q.get()).toBe(2);
    await hot.stop();
  });

  test("the ticker keeps serving the stale value while a refresh is in flight", async () => {
    let value = "old";
    let loads = 0;
    const hot = createHotCache({ probe: async () => false, tickIntervalMs: 10 });
    const q = hot.register("slow", {
      refreshIntervalMs: 5,
      loader: async () => {
        loads++;
        await sleep(40);
        return value;
      },
    });
    await hot.start();
    await q.get();
    expect(loads).toBe(1);
    value = "new";
    await sleep(70); // ticker kicks a 40ms refresh; old value is served meanwhile
    expect(await q.get()).toBe("new");
    expect(loads).toBeGreaterThanOrEqual(2);
    await hot.stop();
  });

  test("a failed background refresh retains the stale value", async () => {
    let ok = true;
    let value = "good";
    let loads = 0;
    const hot = createHotCache({ probe: async () => false, tickIntervalMs: 10 });
    const q = hot.register("flaky-tick", {
      refreshIntervalMs: 5,
      loader: async () => {
        loads++;
        if (!ok) throw new Error("down");
        return value;
      },
    });
    await hot.start();
    await q.get();
    expect(await q.get()).toBe("good");
    ok = false;
    value = "never";
    await sleep(70); // refresh attempts fail → stale retained
    expect(await q.get()).toBe("good");
    expect(loads).toBeGreaterThanOrEqual(2);
    await hot.stop();
  });

  test('mode: "replica" pins the mode and skips the probe', async () => {
    let probed = false;
    const hot = createHotCache({
      mode: "replica",
      probe: async () => {
        probed = true;
        return true;
      },
    });
    await hot.start();
    expect(hot.mode).toBe("replica");
    expect(probed).toBe(false);
    await hot.stop();
  });

  test('mode: "standalone" pins the mode and skips the probe', async () => {
    let probed = false;
    const hot = createHotCache({
      mode: "standalone",
      tickIntervalMs: 50,
      probe: async () => {
        probed = true;
        return true;
      },
    });
    await hot.start();
    expect(hot.mode).toBe("standalone");
    expect(probed).toBe(false);
    await hot.stop();
  });

  test("standalone start warns about queries with no refreshIntervalMs/ttlMs (unbounded staleness)", async () => {
    const warns: string[] = [];
    const logger: LoggerLike = {
      debug() {},
      info() {},
      warn(_a: unknown, b?: string) {
        if (b) warns.push(b);
      },
      error() {},
    };
    const hot = createHotCache({ probe: async () => false, logger });
    hot.register("stale", { loader: async () => 1 });
    hot.register("fresh", { loader: async () => 1, refreshIntervalMs: 100 });
    hot.register("ttl", { loader: async () => 1, ttlMs: 100 });
    await hot.start();
    expect(hot.mode).toBe("standalone");
    expect(warns.some((m) => m.includes("unbounded staleness"))).toBe(true);
    await hot.stop();
  });

  test("the ticker does not refresh queries without refreshIntervalMs (opt-in per query)", async () => {
    let value = 1;
    let loads = 0;
    const hot = createHotCache({
      probe: async () => false,
      tickIntervalMs: 15,
      logger: noopLogger,
    });
    const q = hot.register("static", {
      loader: async () => {
        loads++;
        return value;
      },
    });
    await hot.start();
    expect(await q.get()).toBe(1);
    value = 2;
    await sleep(80); // the ticker runs, but this query has no refreshIntervalMs → no refetch
    expect(await q.get()).toBe(1);
    expect(loads).toBe(1);
    await hot.stop();
  });
});

/* ------------------------- replica change-stream ------------------------- */

const replica = await probeReplica();
// Standalone suites run only when Mongo is REACHABLE but not a replica set.
const maybeStandalone = maybeDescribe(!replica && (await probe()));
const maybeReplica = maybeDescribe(replica);

maybeStandalone("HotCache — replica probe fallback", () => {
  let ctx: Awaited<ReturnType<typeof makeEnterpriseService>>;

  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_hotcache_fallback", {
      cache: null,
      perf: false,
    });
  });

  afterAll(async () => {
    if (ctx) await closeService(ctx);
  });

  test("falls back to the standalone ticker when change streams are unsupported", async () => {
    const hot = createHotCache({
      probe: async () => true, // optimistic: claim replica support
      tickIntervalMs: 15,
      logger: noopLogger,
    });
    let loads = 0;
    const q = hot.register("count", {
      watch: [{ db: ctx.db.client, collection: "products" }],
      refreshIntervalMs: 10,
      loader: async () => {
        loads++;
        return ctx.db.client.collection("products").countDocuments();
      },
    });
    await hot.start();
    expect(hot.mode).toBe("replica"); // optimistic until the stream fails
    // The standalone server rejects $changeStream → all planned streams fail
    // → the cache must fall back to the global ticker.
    const deadline = Date.now() + 5000;
    while (hot.mode === "replica" && Date.now() < deadline) {
      await sleep(50);
    }
    expect(hot.mode).toBe("standalone");

    // The ticker now keeps the entry fresh even without invalidation hooks.
    const initial = await q.get();
    expect(loads).toBeGreaterThanOrEqual(1);
    await ctx.db.client.collection("products").deleteOne({ sku: ctx.seed.productSkus[0] });
    let current = initial;
    const refreshDeadline = Date.now() + 4000;
    while (Date.now() < refreshDeadline) {
      current = await q.get();
      if (current !== initial) break;
      await sleep(50);
    }
    expect(current).not.toBe(initial);
    await hot.stop();
  });
});

maybeReplica("HotCache — replica change-stream invalidation", () => {
  let ctx: Awaited<ReturnType<typeof makeEnterpriseService>>;

  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_hotcache_replica", {
      cache: null,
      perf: false,
    });
  });

  afterAll(async () => {
    if (ctx) await closeService(ctx);
  });

  test("a change stream invalidates a watch-bound query on an external write", async () => {
    const hot = createHotCache({ probe: async () => true, logger: noopLogger });
    let loads = 0;
    const q = hot.register("productCount", {
      watch: [{ db: ctx.db.client, collection: "products" }],
      loader: async () => {
        loads++;
        return ctx.db.client.collection("products").countDocuments();
      },
    });
    await hot.start();
    expect(hot.mode).toBe("replica");
    const before = await q.get();
    expect(loads).toBe(1);
    expect(await q.get()).toBe(before); // cached
    expect(loads).toBe(1);

    // External write bypassing the ORM → no in-process invalidation. The
    // change stream must notice it and drop the cache.
    await ctx.db.client.collection("products").deleteOne({ sku: ctx.seed.productSkus[0] });

    // Change-stream delivery is async — poll until the loader re-runs.
    const initial = loads;
    const deadline = Date.now() + 5000;
    while (loads === initial && Date.now() < deadline) {
      await q.get();
      await sleep(50);
    }
    expect(loads).toBeGreaterThan(initial);
    await hot.stop();
  });
});
