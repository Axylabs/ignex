/**
 * HotCache — real-Mongo integration suite.
 *
 * Verifies DATA INTEGRITY (cached results exactly match what MongoDB returns)
 * and NO SIDE EFFECTS (the cache is read-only: it never writes to the DB,
 * never creates collections, and repeated/warm reads add zero driver queries).
 *
 * Every case runs against a real seeded MongoDB via `tests/helpers.ts`. All
 * loaders read directly through the raw `Db` handle so the ORM's own QueryCache
 * never masks HotCache behavior.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Db } from "mongodb";
import { createHotCache } from "../src/cache/hot-cache/index.ts";
import { sleep } from "../src/utils/timeout.ts";
import {
  closeService,
  makeEnterpriseService,
  maybeDescribe,
  probe as mongoProbe,
  noopLogger,
  probeReplica,
  serverQueryCount,
} from "./helpers.ts";

const maybe = maybeDescribe(await mongoProbe());
const maybeReplica = maybeDescribe(await probeReplica());

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deep snapshot of a collection's documents (data-integrity / no-writes check). */
const snapshotDocs = async (db: Db, collection: string): Promise<string> =>
  JSON.stringify(await db.collection(collection).find({}).sort({ _id: 1 }).toArray());

/** Sorted collection + index list (ensures the cache creates/alters nothing). */
const snapshotStructure = async (db: Db): Promise<string> => {
  const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
  const indexes = await db
    .collection("products")
    .listIndexes()
    .toArray()
    .then((ix) => ix.map((i) => i.name).sort());
  return JSON.stringify({ names, indexes });
};

/** Insert a schema-valid product directly (bypasses ORM + HotCache). Unique sku. */
let probeSeq = 0;
const insertProbeProduct = async (db: Db): Promise<string> => {
  const sku = `HX${String(probeSeq++).padStart(4, "0")}`;
  await db.collection("products").insertOne({
    sku,
    name: "Probe Widget",
    category: "electronics",
    price: 9.99,
    stock: 5,
    tags: ["new"],
  });
  return sku;
};

/* ------------------------- read-through integrity ------------------------ */

maybe("HotCache — real Mongo: read-through integrity", () => {
  let ctx: Awaited<ReturnType<typeof makeEnterpriseService>>;
  let db: Db;

  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_hotcache_mongo_read", { cache: null });
    db = ctx.db.client;
  });

  afterAll(async () => {
    if (ctx) await closeService(ctx);
  });

  test("warm reads return exactly the DB data and add zero driver queries", async () => {
    let loads = 0;
    const hot = createHotCache();
    const q = hot.register("allProducts", {
      loader: async () => {
        loads++;
        return db.collection("products").find({}).sort({ _id: 1 }).toArray();
      },
    });
    const cold = await q.get();
    const fromDb = await db.collection("products").find({}).sort({ _id: 1 }).toArray();
    const q0 = await serverQueryCount(db);
    const warm = await q.get(); // LRU hit — loader not invoked
    const q1 = await serverQueryCount(db);
    expect(loads).toBe(1);
    expect(q1 - q0).toBe(0); // warm read → no driver query
    expect(warm).toEqual(cold); // served from the LRU (data integrity)
    expect(warm).toEqual(fromDb); // and matches the live DB
    await hot.stop();
  });

  test("param-keyed entries match the DB per parameter set", async () => {
    const hot = createHotCache();
    const q = hot.register("productsByCategory", {
      loader: async (category: string) =>
        db.collection("products").find({ category }).sort({ sku: 1 }).toArray(),
    });
    const electronics = await q.get("electronics");
    const apparel = await q.get("apparel");
    expect(electronics).toEqual(
      await db.collection("products").find({ category: "electronics" }).sort({ sku: 1 }).toArray(),
    );
    expect(apparel).toEqual(
      await db.collection("products").find({ category: "apparel" }).sort({ sku: 1 }).toArray(),
    );
    expect(electronics).not.toEqual(apparel); // distinct parameter sets stay distinct
    await hot.stop();
  });
});

/* --------------------------- invalidation freshness ---------------------- */

maybe("HotCache — real Mongo: invalidation freshness", () => {
  let ctx: Awaited<ReturnType<typeof makeEnterpriseService>>;
  let db: Db;

  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_hotcache_mongo_invalidate", { cache: null });
    db = ctx.db.client;
  });

  afterAll(async () => {
    if (ctx) await closeService(ctx);
  });

  test("manual invalidate makes the next read see fresh DB data", async () => {
    let loads = 0;
    const hot = createHotCache();
    const q = hot.register("productCount", {
      loader: async () => {
        loads++;
        return db.collection("products").countDocuments();
      },
    });
    const before = await q.get();
    expect(loads).toBe(1);
    await insertProbeProduct(db); // external write — HotCache is unaware
    expect(await q.get()).toBe(before); // stale, still cached
    q.invalidate();
    expect(await q.get()).toBe(before + 1); // fresh from Mongo
    await hot.stop();
  });

  test("param-level invalidate drops only that entry", async () => {
    let loads = 0;
    const hot = createHotCache();
    const q = hot.register("productById", {
      loader: async (id: string) => {
        loads++;
        return db.collection("products").findOne({ sku: id });
      },
    });
    const skuA = ctx.seed.productSkus[0]!;
    const skuB = ctx.seed.productSkus[1]!;
    await q.get(skuA);
    await q.get(skuB);
    expect(loads).toBe(2);

    // External update on A only.
    await db.collection("products").updateOne({ sku: skuA }, { $set: { stock: 777 } });
    q.invalidate(skuA); // drop just A's entry
    const freshA = await q.get(skuA);
    expect(loads).toBe(3);
    expect(freshA?.stock).toBe(777); // re-read from Mongo
    expect(await q.get(skuB)).toEqual(await db.collection("products").findOne({ sku: skuB })); // B untouched
    expect(loads).toBe(3);
    await hot.stop();
  });

  test("invalidateCollection clears watch-bound queries only", async () => {
    let boundLoads = 0;
    let freeLoads = 0;
    const hot = createHotCache();
    const bound = hot.register("boundCount", {
      watch: [{ db, collection: "products" }],
      loader: async () => {
        boundLoads++;
        return db.collection("products").countDocuments();
      },
    });
    const free = hot.register("freeCount", {
      loader: async () => {
        freeLoads++;
        return db.collection("orders").countDocuments();
      },
    });
    const boundBefore = await bound.get();
    const freeBefore = await free.get();
    expect(boundLoads).toBe(1);
    await insertProbeProduct(db);
    hot.invalidateCollection("products");
    expect(await bound.get()).toBe(boundBefore + 1); // reloaded fresh
    expect(boundLoads).toBe(2);
    expect(await free.get()).toBe(freeBefore); // orders untouched + still cached
    expect(freeLoads).toBe(1);
    await hot.stop();
  });

  test("ORM write + invalidateCollection is the documented manual-wiring path", async () => {
    const hot = createHotCache();
    const q = hot.register("ormCount", {
      watch: [{ db, collection: "products" }],
      loader: async () => db.collection("products").countDocuments(),
    });
    const before = await q.get();
    // ORM write (in-process) — does NOT touch the HotCache on its own.
    await ctx.db.insertOne("products", {
      sku: "OO0001",
      name: "Via ORM",
      category: "home",
      price: 1.5,
      stock: 2,
      tags: ["sale"],
    });
    expect(await q.get()).toBe(before); // still stale
    // Wire the ORM's after-write hook to the HotCache manually.
    hot.invalidateCollection("products");
    expect(await q.get()).toBe(before + 1); // fresh
    await hot.stop();
  });
});

/* ------------------- standalone ticker + autoRefresh --------------------- */

maybe("HotCache — real Mongo: standalone ticker freshness", () => {
  let ctx: Awaited<ReturnType<typeof makeEnterpriseService>>;
  let db: Db;

  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_hotcache_mongo_ticker", { cache: null });
    db = ctx.db.client;
  });

  afterAll(async () => {
    if (ctx) await closeService(ctx);
  });

  test("the ticker re-fetches a real-Mongo-backed entry after external writes", async () => {
    const hot = createHotCache({ probe: async () => false, tickIntervalMs: 20 });
    const q = hot.register("tickerCount", {
      refreshIntervalMs: 10,
      loader: async () => db.collection("products").countDocuments(),
    });
    await hot.start();
    expect(hot.mode).toBe("standalone");
    const before = await q.get();
    await insertProbeProduct(db);
    expect(await q.get()).toBe(before); // stale until a tick refreshes
    await sleepMs(120);
    expect(await q.get()).toBe(before + 1); // fresh from Mongo
    await hot.stop();
  });

  test("autoRefresh:false disables the ticker — manual invalidation only", async () => {
    const hot = createHotCache({
      probe: async () => false,
      autoRefresh: false,
      tickIntervalMs: 20,
    });
    const q = hot.register("noRefreshCount", {
      refreshIntervalMs: 10,
      loader: async () => db.collection("products").countDocuments(),
    });
    await hot.start();
    expect(hot.autoRefresh).toBe(false);
    const before = await q.get();
    await insertProbeProduct(db);
    await sleepMs(120); // ticker is off → no background refetch
    expect(await q.get()).toBe(before);
    q.invalidate(); // manual control restores freshness
    expect(await q.get()).toBe(before + 1);
    await hot.stop();
  });

  test("ttl expiry forces a fresh read from Mongo", async () => {
    const hot = createHotCache({ probe: async () => false });
    const q = hot.register("ttlCount", {
      ttlMs: 40,
      loader: async () => db.collection("products").countDocuments(),
    });
    await hot.start();
    const before = await q.get();
    await insertProbeProduct(db);
    expect(await q.get()).toBe(before); // within TTL → stale
    await sleepMs(80);
    expect(await q.get()).toBe(before + 1); // expired → reloaded from Mongo
    await hot.stop();
  });
});

/* ------------------------- no side effects & correctness ----------------- */

maybe("HotCache — real Mongo: no side effects & correctness", () => {
  let ctx: Awaited<ReturnType<typeof makeEnterpriseService>>;
  let db: Db;

  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_hotcache_mongo_noop", { cache: null });
    db = ctx.db.client;
  });

  afterAll(async () => {
    if (ctx) await closeService(ctx);
  });

  test("cache reads never write to the DB and create/alter nothing", async () => {
    const docsBefore = await snapshotDocs(db, "products");
    const structureBefore = await snapshotStructure(db);
    const hot = createHotCache();
    let loads = 0;
    const q = hot.register("readOnly", {
      loader: async (limit: number) => {
        loads++;
        return db.collection("products").find({}).limit(limit).toArray();
      },
    });
    await q.get(3);
    await q.get(3); // warm
    await q.get(10);
    q.invalidate(3);
    await q.get(3); // reload
    hot.invalidateCollection("products");
    hot.clear();
    await hot.stop();
    const docsAfter = await snapshotDocs(db, "products");
    const structureAfter = await snapshotStructure(db);
    expect(docsAfter).toBe(docsBefore); // byte-for-byte identical
    expect(structureAfter).toBe(structureBefore); // no collections/indexes added
    expect(loads).toBe(3);
  });

  test("concurrent identical reads dedupe into one loader call with consistent data", async () => {
    const hot = createHotCache();
    let loads = 0;
    const q = hot.register("dedupedCount", {
      loader: async () => {
        loads++;
        await sleep(30); // widen the race window
        return db.collection("products").countDocuments();
      },
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => q.get()));
    expect(loads).toBe(1);
    for (const r of results) expect(r).toBe(await db.collection("products").countDocuments());
    await hot.stop();
  });

  test("a loader error (real Mongo) is not cached — the next read retries", async () => {
    const hot = createHotCache();
    let loads = 0;
    const q = hot.register("flakyReal", {
      loader: async () => {
        loads++;
        if (loads === 1) throw new Error("simulated transient db failure");
        return db.collection("products").countDocuments();
      },
    });
    await expect(q.get()).rejects.toThrow("simulated transient db failure");
    const fresh = await q.get();
    expect(fresh).toBe(await db.collection("products").countDocuments());
    expect(loads).toBe(2);
    await hot.stop();
  });

  test("stop() halts background refresh but read-through still works", async () => {
    const hot = createHotCache({ probe: async () => false, tickIntervalMs: 20 });
    const q = hot.register("stopCount", {
      refreshIntervalMs: 10,
      loader: async () => db.collection("products").countDocuments(),
    });
    await hot.start();
    const before = await q.get();
    await hot.stop(); // tear down the ticker
    await insertProbeProduct(db);
    await sleepMs(120); // no ticker → no refresh
    expect(await q.get()).toBe(before);
    q.invalidate(); // manual invalidation still fine after stop
    expect(await q.get()).toBe(before + 1);
    await hot.stop(); // idempotent
  });

  test("invalidating one query leaves sibling queries untouched (isolation)", async () => {
    const hot = createHotCache();
    let aLoads = 0;
    let bLoads = 0;
    const qa = hot.register("isoA", {
      loader: async () => {
        aLoads++;
        return db.collection("products").countDocuments();
      },
    });
    const qb = hot.register("isoB", {
      loader: async () => {
        bLoads++;
        return db.collection("orders").countDocuments();
      },
    });
    await qa.get();
    await qb.get();
    qa.invalidate();
    expect(await qa.get()).toBe(await db.collection("products").countDocuments());
    expect(aLoads).toBe(2);
    expect(await qb.get()).toBe(await db.collection("orders").countDocuments()); // cached
    expect(bLoads).toBe(1);
    await hot.stop();
  });
});

/* ------------------------- replica change stream ------------------------- */

maybeReplica("HotCache — real Mongo: replica change-stream integrity", () => {
  let ctx: Awaited<ReturnType<typeof makeEnterpriseService>>;
  let db: Db;

  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_hotcache_mongo_replica", { cache: null });
    db = ctx.db.client;
  });

  afterAll(async () => {
    if (ctx) await closeService(ctx);
  });

  test("a change stream invalidates on external writes and data stays fresh", async () => {
    const hot = createHotCache({ probe: async () => true, logger: noopLogger });
    const q = hot.register("replicaCount", {
      watch: [{ db, collection: "products" }],
      loader: async () => db.collection("products").countDocuments(),
    });
    await hot.start();
    expect(hot.mode).toBe("replica");
    const before = await q.get();
    await insertProbeProduct(db); // external write → change stream
    // Delivery is async — poll until the cache reflects the new DB count.
    let current = before;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      current = await q.get();
      if (current === before + 1) break;
      await sleepMs(50);
    }
    expect(current).toBe(before + 1); // invalidated + re-read from Mongo
    expect(current).toBe(await db.collection("products").countDocuments()); // integrity
    await hot.stop();
  });
});
