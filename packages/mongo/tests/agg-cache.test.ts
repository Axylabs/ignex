/**
 * Aggregation caching suite.
 *
 * Materializing aggregation ops — `pipeline().toArray()/.first()`, `groupBy`,
 * `dateRangeAnalysis`, `textSearch`, `lookupJoin`, `paginateFlexible` — route
 * through the shared `QueryCache` (write-through, per-source-collection
 * invalidation) + in-flight dedup, mirroring flat reads. This suite pins:
 *
 *   - warm reads = 0 driver queries; an ORM write invalidates (single + joined)
 *   - bypasses: `$sample` pipelines, sessions, per-op `cache:false`, live
 *     cursors (`aggregate()`, `pipeline().cursor()`)
 *   - concurrent identical aggregations coalesce into one driver call
 *
 * The `collectAggSources` / `isCacheablePipeline` helpers are unit-tested
 * without Mongo at the top of the file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { probeMongoCapabilities } from "../src/capabilities.ts";
import { collectAggSources, isCacheablePipeline } from "../src/service/aggregation/helpers.ts";
import type { Customer, Order } from "./fixtures/enterprise.ts";
import {
  closeService,
  type EnterpriseServiceContext,
  makeEnterpriseService,
  maybeDescribe,
  probe,
  serverQueryCount,
} from "./helpers.ts";

/* --------------------- unit tests (no Mongo required) --------------------- */

describe("aggregation cache helpers", () => {
  test("collectAggSources finds $lookup / $unionWith / $facet sources", () => {
    const pipeline = [
      { $match: { status: "paid" } },
      {
        $lookup: {
          from: "customers",
          localField: "customerId",
          foreignField: "_id",
          as: "customer",
        },
      },
      {
        $lookup: {
          from: "shipments",
          localField: "_id",
          foreignField: "orderId",
          as: "shipments",
          pipeline: [
            { $lookup: { from: "users", localField: "_id", foreignField: "orderId", as: "u" } },
          ],
        },
      },
      { $unionWith: { coll: "archives" } },
      {
        $facet: {
          byStatus: [
            { $lookup: { from: "reviews", localField: "_id", foreignField: "o", as: "r" } },
          ],
        },
      },
    ];
    const sources = collectAggSources("orders", pipeline, ["extra"]);
    for (const expected of [
      "orders",
      "customers",
      "shipments",
      "users",
      "archives",
      "reviews",
      "extra",
    ]) {
      expect(sources).toContain(expected);
    }
  });

  test("isCacheablePipeline rejects writes and non-determinism ($out/$merge/$sample)", () => {
    expect(isCacheablePipeline([{ $match: {} }, { $limit: 5 }])).toBe(true);
    expect(isCacheablePipeline([{ $sample: { size: 3 } }])).toBe(false);
    expect(isCacheablePipeline([{ $out: "backup" }])).toBe(false);
    expect(isCacheablePipeline([{ $merge: { into: "backup" } }])).toBe(false);
    // Non-determinism nested inside a $facet branch is caught too.
    expect(isCacheablePipeline([{ $facet: { a: [{ $sample: { size: 1 } }] } }])).toBe(false);
  });
});

/* --------------------------- real MongoDB suite --------------------------- */

const maybe = maybeDescribe(await probe());

maybe("aggregation caching (real MongoDB)", () => {
  let ctx: EnterpriseServiceContext;

  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_agg_cache", {});
  });

  afterAll(async () => {
    if (ctx) await closeService(ctx);
  });

  test("pipeline().toArray() caches and invalidates on an ORM write", async () => {
    const { db } = ctx;
    const group = () =>
      db
        .pipeline("orders")
        .group({ _id: "$status", n: { $sum: 1 } })
        .sort({ _id: 1 })
        .toArray();
    const q0 = await serverQueryCount(db.client);
    const first = await group();
    const q1 = await serverQueryCount(db.client);
    expect(q1 - q0).toBe(1); // cold → one driver query
    const warm = await group();
    const q2 = await serverQueryCount(db.client);
    expect(q2 - q1).toBe(0); // warm → served from the cache
    expect(warm).toEqual(first);

    // An ORM write invalidates → the next read re-runs (one driver query).
    const victim = (await db.findMany("orders", {}, { limit: 1 }))[0]!;
    await db.deleteOne("orders", { _id: victim._id });
    const q3 = await serverQueryCount(db.client);
    const fresh = await group();
    const q4 = await serverQueryCount(db.client);
    expect(q4 - q3).toBe(1);
    expect(fresh).not.toEqual(first);
  });

  test("pipeline().first() caches and invalidates on an ORM write", async () => {
    const { db } = ctx;
    const firstOne = () => db.pipeline("orders").sort({ placedAt: -1 }).first();
    const q0 = await serverQueryCount(db.client);
    const a = await firstOne();
    const q1 = await serverQueryCount(db.client);
    expect(q1 - q0).toBe(1);
    const b = await firstOne();
    const q2 = await serverQueryCount(db.client);
    expect(q2 - q1).toBe(0);
    expect(b).toEqual(a);

    // Delete the currently-first order → the cached first() must refresh.
    await db.deleteOne("orders", { _id: (a as Order)._id });
    const q3 = await serverQueryCount(db.client);
    const c = await firstOne();
    const q4 = await serverQueryCount(db.client);
    expect(q4 - q3).toBe(1);
    expect(c).not.toEqual(a);
  });

  test("a join is invalidated when the JOINED collection changes (multi-collection)", async () => {
    const { db } = ctx;
    const join = () =>
      db.lookupJoin<"orders", Order & { customer?: Customer[] }>("orders", {}, [
        {
          fromCollection: "customers",
          localField: "customerId",
          foreignField: "_id",
          as: "customer",
        },
      ]);
    const q0 = await serverQueryCount(db.client);
    const first = await join();
    const q1 = await serverQueryCount(db.client);
    expect(q1 - q0).toBe(1);
    const warm = await join();
    const q2 = await serverQueryCount(db.client);
    expect(q2 - q1).toBe(0);

    // Delete a CUSTOMER that an order references — the join (cached under
    // orders AND customers) must be invalidated and re-fetch.
    const order = (await db.findMany("orders", {}, { limit: 1 }))[0]!;
    await db.deleteOne("customers", { _id: order.customerId });
    const q3 = await serverQueryCount(db.client);
    const fresh = await join();
    const q4 = await serverQueryCount(db.client);
    expect(q4 - q3).toBe(1);
    expect(fresh).not.toEqual(first);
  });

  test("groupBy caches and invalidates on an ORM write", async () => {
    const { db } = ctx;
    const group = () =>
      db.groupBy(
        "orders",
        {},
        { groupBy: "$status", accumulate: { n: { $sum: 1 } }, sort: { _id: 1 } },
      );
    const q0 = await serverQueryCount(db.client);
    const first = await group();
    const q1 = await serverQueryCount(db.client);
    expect(q1 - q0).toBe(1);
    const warm = await group();
    const q2 = await serverQueryCount(db.client);
    expect(q2 - q1).toBe(0);
    expect(warm).toEqual(first);

    const victim = (await db.findMany("orders", {}, { limit: 1 }))[0]!;
    await db.deleteOne("orders", { _id: victim._id });
    const q3 = await serverQueryCount(db.client);
    const fresh = await group();
    const q4 = await serverQueryCount(db.client);
    expect(q4 - q3).toBe(1);
    expect(fresh).not.toEqual(first);
  });

  test("dateRangeAnalysis caches and invalidates on an ORM write", async () => {
    const { db } = ctx;
    const range = () =>
      db.dateRangeAnalysis(
        "orders",
        {},
        {
          dateField: "placedAt",
          startDate: new Date(0),
          endDate: new Date(8640000000000000),
        },
        { accumulate: { n: { $sum: 1 } }, sort: { _id: 1 } },
      );
    const q0 = await serverQueryCount(db.client);
    const first = await range();
    const q1 = await serverQueryCount(db.client);
    expect(q1 - q0).toBe(1);
    const warm = await range();
    const q2 = await serverQueryCount(db.client);
    expect(q2 - q1).toBe(0);
    expect(warm).toEqual(first);

    const victim = (await db.findMany("orders", {}, { limit: 1 }))[0]!;
    await db.deleteOne("orders", { _id: victim._id });
    const q3 = await serverQueryCount(db.client);
    const fresh = await range();
    const q4 = await serverQueryCount(db.client);
    expect(q4 - q3).toBe(1);
    expect(fresh).not.toEqual(first);
  });

  test("textSearch caches and invalidates on an ORM write", async () => {
    const { db } = ctx;
    const term = "NinoxCacheUnique";
    const search = () =>
      db.textSearch(
        "products",
        {},
        { searchFields: ["name"], searchTerm: term, useRegex: true },
        { page: 1, limit: 10 },
      );
    const q0 = await serverQueryCount(db.client);
    const first = await search();
    const q1 = await serverQueryCount(db.client);
    expect(q1 - q0).toBe(1);
    expect(first.data.length).toBe(0); // term matches nothing yet
    const warm = await search();
    const q2 = await serverQueryCount(db.client);
    expect(q2 - q1).toBe(0);

    // Insert a matching product (unique sku) → write-through invalidation.
    await db.insertOne("products", {
      sku: "ZZ0001",
      name: term,
      category: "electronics",
      price: 1,
      stock: 1,
      tags: ["new"],
    });
    const q3 = await serverQueryCount(db.client);
    const fresh = await search();
    const q4 = await serverQueryCount(db.client);
    expect(q4 - q3).toBe(1);
    expect(fresh.data.length).toBe(1);
  });

  test("paginateFlexible caches and invalidates on an ORM write", async () => {
    const { db } = ctx;
    const page = () =>
      db.paginateFlexible("orders", {}, { page: 1, limit: 5, sort: { placedAt: -1 } });
    const q0 = await serverQueryCount(db.client);
    const first = await page();
    const q1 = await serverQueryCount(db.client);
    expect(q1 - q0).toBe(1);
    const warm = await page();
    const q2 = await serverQueryCount(db.client);
    expect(q2 - q1).toBe(0);
    expect(warm).toEqual(first);

    const victim = (await db.findMany("orders", {}, { limit: 1 }))[0]!;
    await db.deleteOne("orders", { _id: victim._id });
    const q3 = await serverQueryCount(db.client);
    const fresh = await page();
    const q4 = await serverQueryCount(db.client);
    expect(q4 - q3).toBe(1);
    expect(fresh.totalCount).toBe(first.totalCount - 1);
  });

  test("$sample pipelines are NOT cached (non-deterministic)", async () => {
    const { db } = ctx;
    const q0 = await serverQueryCount(db.client);
    await db.pipeline("orders").sample(1).toArray();
    await db.pipeline("orders").sample(1).toArray();
    const delta = (await serverQueryCount(db.client)) - q0;
    expect(delta).toBe(2); // every $sample hits the DB
  });

  test("aggregations with a session bypass the cache (transactional reads)", async () => {
    const { db } = ctx;
    const caps = await probeMongoCapabilities(db.client);
    const q0 = await serverQueryCount(db.client);
    await db.transaction(async (session) => {
      await db
        .pipeline("orders", { session: session ?? undefined })
        .group({ _id: "$status", n: { $sum: 1 } })
        .sort({ _id: 1 })
        .toArray();
      await db
        .pipeline("orders", { session: session ?? undefined })
        .group({ _id: "$status", n: { $sum: 1 } })
        .sort({ _id: 1 })
        .toArray();
    });
    const delta = (await serverQueryCount(db.client)) - q0;
    if (caps.transactionsSupported) {
      // Real session → never cached → both reads hit the DB (≥2 driver
      // queries). A local replica container may add ambient queries from its
      // healthcheck `mongosh` (the `admin.atlascli` Atlas-CLI detection
      // aggregate), so assert a lower bound rather than an exact count — the
      // point is that neither read was served from the cache.
      expect(delta).toBeGreaterThanOrEqual(2);
    } else {
      // Standalone graceful fallback runs with a null session → the cache
      // applies, so the second identical read is a cache hit.
      expect(delta).toBe(1);
    }
  });

  test("per-op cache:false bypasses the aggregation cache", async () => {
    const { db } = ctx;
    const q0 = await serverQueryCount(db.client);
    await db
      .pipeline("orders", { cache: false })
      .group({ _id: "$status", n: { $sum: 1 } })
      .sort({ _id: 1 })
      .toArray();
    await db
      .pipeline("orders", { cache: false })
      .group({ _id: "$status", n: { $sum: 1 } })
      .sort({ _id: 1 })
      .toArray();
    const delta = (await serverQueryCount(db.client)) - q0;
    expect(delta).toBe(2); // bypassed → both hit the DB
  });

  test("aggregate() and pipeline().cursor() are not cached (live cursors)", async () => {
    const { db } = ctx;
    const q0 = await serverQueryCount(db.client);
    const c1 = await db.aggregate("orders", () => [{ $group: { _id: "$status", n: { $sum: 1 } } }]);
    await c1.toArray();
    const c2 = await db.aggregate("orders", () => [{ $group: { _id: "$status", n: { $sum: 1 } } }]);
    await c2.toArray();
    const q1 = await serverQueryCount(db.client);
    expect(q1 - q0).toBe(2);

    await db
      .pipeline("orders")
      .group({ _id: "$status", n: { $sum: 1 } })
      .cursor()
      .toArray();
    await db
      .pipeline("orders")
      .group({ _id: "$status", n: { $sum: 1 } })
      .cursor()
      .toArray();
    const q2 = await serverQueryCount(db.client);
    expect(q2 - q1).toBe(2);
  });

  test("concurrent identical aggregations coalesce into one driver call", async () => {
    const { db } = ctx;
    const q0 = await serverQueryCount(db.client);
    const [a, b] = await Promise.all([
      db
        .pipeline("orders")
        .match({ status: { $in: ["paid", "shipped"] } })
        .group({ _id: "$status", n: { $sum: 1 } })
        .sort({ _id: 1 })
        .toArray(),
      db
        .pipeline("orders")
        .match({ status: { $in: ["paid", "shipped"] } })
        .group({ _id: "$status", n: { $sum: 1 } })
        .sort({ _id: 1 })
        .toArray(),
    ]);
    const delta = (await serverQueryCount(db.client)) - q0;
    expect(a).toEqual(b);
    expect(delta).toBe(1); // in-flight dedup coalesced the two
  });

  test("paginateCursor (keyset) is NOT cached — pages are live reads", async () => {
    const { db } = ctx;
    const sort = { placedAt: -1, _id: 1 } as const;
    const q0 = await serverQueryCount(db.client);
    const p1 = await db.paginateCursor("orders", {}, { sort, limit: 5 });
    const p2 = await db.paginateCursor("orders", {}, { sort, limit: 5 });
    const delta = (await serverQueryCount(db.client)) - q0;
    expect(p1.data.length).toBeGreaterThan(0);
    expect(p2.data).toEqual(p1.data);
    expect(delta).toBe(2); // identical keyset pages each hit the DB
  });

  test("concurrent reads + writes stay consistent (churn under the race guard)", async () => {
    const { db } = ctx;
    const group = () =>
      db
        .pipeline("orders")
        .group({ _id: "$status", n: { $sum: 1 } })
        .sort({ _id: 1 })
        .toArray();
    await group(); // warm the cache

    const customer = (await db.findMany("customers", {}, { limit: 1 }))[0]!;
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      ops.push(group()); // concurrent cached aggregation read
      ops.push(
        db
          .findMany("orders", {}, { limit: 1 })
          .then(([victim]) =>
            victim ? db.deleteOne("orders", { _id: victim._id }) : Promise.resolve(null),
          ),
      );
      ops.push(
        db.insertOne("orders", {
          customerId: customer._id,
          status: "paid",
          items: [{ sku: "CHURN1", name: "churn", qty: 1, unitPrice: 1 }],
          totals: { subtotal: 1, tax: 0, shipping: 0, grandTotal: 1 },
          billing: { address: { street: "s", city: "c", country: "cc" } },
          placedAt: new Date(),
        }),
      );
    }
    await Promise.all(ops);

    // After the dust settles, a fresh aggregation matches the live DB — no
    // stale-by-arrival entry survived a concurrent write.
    const live = await db.countDocuments("orders");
    const final = await group();
    const total = (final as Array<{ n: number }>).reduce((acc, r) => acc + r.n, 0);
    expect(total).toBe(live);
  });
});
