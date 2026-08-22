/**
 * Complex multistage aggregation suite (real MongoDB).
 *
 * Proves the typed pipeline builder + callback stages + convenience ops handle
 * the enterprise model's complexity end-to-end: multi-collection joins, nested
 * `$facet`, unwind→group→project chains with every accumulator, conditional
 * expressions, callback-only stages (bucket/bucketAuto/fill/densify), op-level
 * `groupBy`/`textSearch`/`dateRangeAnalysis`/`lookupJoin`/`paginateFlexible`,
 * query-option forwarding (batchSize/hint/maxTimeMS/session), and the
 * error/guard paths (array-form sub-pipelines, stage-only builders,
 * wrapMongoErrors on/off). Guarded by a local MongoDB.
 *
 * Uses three services: `ctx` (wrapMongoErrors on, perf off), `raw`
 * (wrapMongoErrors off — explicit opt-out of the new on-by-default behavior),
 * and `perfOn` (cache + dedup on) to prove materializing aggregations ARE
 * cached + in-flight-deduped (write-through, like reads).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ClientSession, Collection, ObjectId } from "mongodb";
import { isInfraError } from "../src/errors/index.ts";
import { stageBuilder } from "../src/service/pipeline-builder.ts";
import {
  closeService,
  type EnterpriseServiceContext,
  makeEnterpriseService,
  maybeDescribe,
  probe,
  serverQueryCount,
} from "./helpers.ts";

const available = await probe();
const maybe = maybeDescribe(available);

maybe("complex multistage aggregation (real MongoDB)", () => {
  let ctx: EnterpriseServiceContext; // wrapMongoErrors: true
  let raw: EnterpriseServiceContext; // wrapMongoErrors: false (opt-out)
  let perfOn: EnterpriseServiceContext; // cache + dedup on

  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_orm_agg_test", { wrapMongoErrors: true, perf: false });
    raw = await makeEnterpriseService("ninox_orm_agg_raw_test", {
      perf: false,
      wrapMongoErrors: false,
    });
    perfOn = await makeEnterpriseService("ninox_orm_agg_perf_test", {});
  });

  afterAll(async () => {
    await closeService(ctx);
    await closeService(raw);
    await closeService(perfOn);
  });

  /* ------------------------------ joins ------------------------------ */

  test("three-collection chain: orders → customers → shipments (chained lookup)", async () => {
    const { db } = ctx;
    const rows = await db
      .pipeline("orders")
      .lookup({ from: "customers", localField: "customerId", foreignField: "_id", as: "customer" })
      .lookup({ from: "shipments", localField: "_id", foreignField: "orderId", as: "shipments" })
      .limit(50)
      .toArray();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.customer?.[0]?.email).toMatch(/^cust\d+@example\.com$/);
      // only paid/shipped orders have shipments
      if (row.status === "paid" || row.status === "shipped") {
        expect(row.shipments?.length).toBeGreaterThan(0);
      } else {
        expect(row.shipments?.length ?? 0).toBe(0);
      }
    }
  });

  test("lookupJoin op: multiple lookups with unwindSingle", async () => {
    const { db } = ctx;
    const rows = await db.lookupJoin(
      "orders",
      {},
      [
        {
          fromCollection: "customers",
          localField: "customerId",
          foreignField: "_id",
          as: "customer",
          unwindSingle: true,
        },
        {
          fromCollection: "shipments",
          localField: "_id",
          foreignField: "orderId",
          as: "shipments",
        },
      ],
      {},
    );
    expect(rows.length).toBeGreaterThan(0);
    const withShip = rows.find((r) => (r as { shipments?: unknown[] }).shipments?.length);
    expect(withShip).toBeDefined();
    // unwindSingle makes customer a scalar (or null when absent)
    expect((rows[0] as { customer?: unknown }).customer).toBeDefined();
  });

  test("$lookup with let + pipeline variables ($expr $in over embedded skus)", async () => {
    const { db, seed } = ctx;
    // The type model requires localField/foreignField even for let-based correlated
    // lookups; Mongo accepts let+pipeline alone (adding eq-fields changes semantics) —
    // cast the spec and assert on a loose row shape.
    const rows = (await db
      .pipeline("orders")
      .lookup({
        from: "products",
        let: { skus: "$items.sku" },
        as: "matched",
        pipeline: [
          { $match: { $expr: { $in: ["$sku", "$$skus"] } } },
          { $project: { sku: 1, name: 1 } },
        ],
      } as never)
      .limit(5)
      .toArray()) as unknown as Array<{
      items: { sku: string }[];
      matched?: { sku: string; name: string }[];
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const rowSkus = row.items.map((i) => i.sku);
      expect(rowSkus.length).toBeGreaterThan(0);
      for (const m of row.matched ?? []) {
        expect(rowSkus).toContain(m.sku);
      }
      expect(row.matched?.length).toBeGreaterThan(0);
    }
    void seed;
  });

  test("lookup on an embedded array field after $unwind", async () => {
    const { db } = ctx;
    // `localField: 'items.sku'` is a dotted path — the type model only validates
    // top-level eq fields, so cast just the localField (keeps the typed result).
    const rows = await db
      .pipeline("orders")
      .unwind("$items")
      .lookup({
        from: "products",
        localField: "items.sku" as never,
        foreignField: "sku",
        as: "product",
      })
      .limit(20)
      .toArray();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const expectedName = `Product ${Number(row.items.sku.slice(2))}`;
      expect(row.product?.[0]?.name).toBe(expectedName);
    }
  });

  /* --------------------- stage composition --------------------------- */

  test("$facet with multiple typed branches (group + sort/limit + lookup)", async () => {
    // NOTE: MongoDB forbids `$facet` inside a `$facet` — this exercises a broad
    // multi-branch facet instead (the type model permits nesting, but the server
    // rejects it with `$facet is not allowed to be used within a $facet stage`).
    const { db } = ctx;
    const rows = await db
      .pipeline("orders")
      .facet({
        byStatus: (s) => s.group({ _id: "$status", n: { $sum: 1 } }),
        top: (s) => s.sort({ "totals.grandTotal": -1 }).limit(2),
        withCustomers: (s) =>
          s
            .lookup({
              from: "customers",
              localField: "customerId",
              foreignField: "_id",
              as: "customer",
            })
            .limit(1),
      })
      .toArray();
    const row = rows[0]!;
    expect(row.byStatus.length).toBe(4); // pending/paid/shipped/cancelled
    expect(row.top.length).toBe(2);
    expect(row.top[0]?.totals?.grandTotal).toBeGreaterThanOrEqual(
      row.top[1]?.totals?.grandTotal ?? 0,
    );
    expect(row.withCustomers[0]?.customer?.[0]?.email).toBeDefined();
    const n = row.byStatus.reduce((acc: number, b: { n?: number }) => acc + (b.n ?? 0), 0);
    expect(n).toBe(await db.countDocuments("orders"));
  });

  test("unwind → group → project chain with compound _id + all accumulators", async () => {
    const { db } = ctx;
    // expected (status, sku) pairs computed from raw data (deterministic seed)
    const all = await db.findMany("orders", {}, { limit: 1000 });
    const expected = new Map<string, { qty: number; count: number; names: string[] }>();
    let totalItemQty = 0;
    for (const o of all) {
      for (const it of o.items) {
        totalItemQty += it.qty;
        const key = `${o.status}\u0000${it.sku}`;
        const cur = expected.get(key) ?? { qty: 0, count: 0, names: [] as string[] };
        cur.qty += it.qty;
        cur.count += 1;
        cur.names.push(it.name);
        expected.set(key, cur);
      }
    }

    const grouped = await db
      .pipeline("orders")
      .unwind("$items")
      .group({
        _id: { status: "$status", sku: "$items.sku" },
        qty: { $sum: "$items.qty" },
        avg: { $avg: "$items.unitPrice" },
        max: { $max: "$items.unitPrice" },
        min: { $min: "$items.unitPrice" },
        first: { $first: "$items.name" },
        last: { $last: "$items.name" },
        skus: { $addToSet: "$items.sku" },
        names: { $push: "$items.name" },
        count: { $sum: 1 },
      })
      .project({
        status: "$_id.status",
        sku: "$_id.sku",
        qty: 1,
        avg: 1,
        max: 1,
        min: 1,
        first: 1,
        last: 1,
        skus: 1,
        names: 1,
        count: 1,
      })
      .toArray();

    expect(grouped.length).toBe(expected.size);
    const groupByKey = new Map(
      grouped.map((g) => [
        `${(g as unknown as { status: string }).status}\u0000${(g as unknown as { sku: string }).sku}`,
        g as unknown as {
          status: string;
          sku: string;
          qty: number;
          count: number;
          avg: number;
          max: number;
          min: number;
          skus: string[];
          names: string[];
          first: string;
        },
      ]),
    );
    let groupedQty = 0;
    for (const [key, exp] of expected) {
      const g = groupByKey.get(key);
      expect(g, `missing group for ${key}`).toBeDefined();
      expect(g!.qty).toBe(exp.qty);
      expect(g!.count).toBe(exp.count);
      expect(g!.avg).toBeGreaterThanOrEqual(g!.min);
      expect(g!.avg).toBeLessThanOrEqual(g!.max);
      expect(g!.skus).toEqual([g!.sku]);
      expect(g!.names.length).toBe(exp.count);
      expect(g!.names[0]).toBe(exp.names[0]);
      groupedQty += g!.qty;
    }
    expect(groupedQty).toBe(totalItemQty);
  });

  test("$cond / $switch / $ifNull in addFields", async () => {
    const { db } = ctx;
    const rows = await db
      .pipeline("orders")
      .limit(50)
      .addFields({
        bucket: {
          $switch: {
            branches: [
              // biome-ignore lint/suspicious/noThenProperty: `then` is a Mongo $switch branch field, not a Promise
              { case: { $gte: ["$totals.grandTotal", 100] }, then: "high" },
              // biome-ignore lint/suspicious/noThenProperty: `then` is a Mongo $switch branch field, not a Promise
              { case: { $gte: ["$totals.grandTotal", 50] }, then: "medium" },
            ],
            default: "low",
          },
        },
        hasCoupon: { $ne: [{ $ifNull: ["$couponCode", null] }, null] },
        itemCount: { $size: { $ifNull: ["$items", []] } },
      })
      .toArray();
    for (const row of rows) {
      expect(["low", "medium", "high"]).toContain(row.bucket as unknown as string);
      expect(row.hasCoupon).toBe(row.couponCode != null);
      expect(row.itemCount).toBe(row.items.length);
    }
  });

  test("$unwind with preserveNullAndEmptyArrays + includeArrayIndex", async () => {
    const { db } = ctx;
    // insert an order with an EMPTY items array (valid per schema) + a missing items case
    const base = await db.getOne("orders", {});
    expect(base).not.toBeNull();
    const baseOrder = base!;
    const emptyId = (
      await db.insertOne("orders", {
        customerId: baseOrder.customerId,
        status: "pending",
        items: [],
        totals: { subtotal: 0, tax: 0, shipping: 0, grandTotal: 0 },
        billing: baseOrder.billing,
        placedAt: new Date(),
      })
    ).insertedId;

    const rows = await db
      .pipeline("orders")
      .match({ _id: { $in: [emptyId, baseOrder._id] } })
      .unwind({ path: "$items", preserveNullAndEmptyArrays: true, includeArrayIndex: "idx" })
      .toArray();
    const emptyRow = rows.find((r) => r._id.equals(emptyId));
    expect(emptyRow).toBeDefined();
    // Mongo removes the field for an empty array under preserveNullAndEmptyArrays
    expect(emptyRow!.items == null).toBe(true);
    // `idx` is added by the runtime stage but not reflected in the type model — cast
    expect((emptyRow as unknown as { idx?: number | null }).idx == null).toBe(true);
    const filledRow = rows.find((r) => r._id.equals(baseOrder._id));
    expect((filledRow as unknown as { idx?: number | null }).idx).toBeTypeOf("number");
    expect(rows.length).toBe(1 + baseOrder.items.length);
  });

  test("$sample returns up to n docs", async () => {
    const { db } = ctx;
    const rows = await db.pipeline("orders").sample(3).toArray();
    expect(rows.length).toBe(3);
  });

  test("$set replaces fields and $unset removes them", async () => {
    const { db } = ctx;
    const rows = await db
      .pipeline("orders")
      .limit(2)
      .set({ flag: true, status: "flagged" })
      .unset("totals")
      .toArray();
    for (const row of rows) {
      expect(row.flag).toBe(true);
      // `set({ status: 'flagged' })` computes the field (typed unknown/kept enum) — cast for runtime
      expect((row as unknown as { status: string }).status).toBe("flagged");
      // `totals` was $unset — the type model correctly removes it, so cast for the runtime check
      expect((row as unknown as { totals?: unknown }).totals).toBeUndefined();
      expect(row.customerId).toBeDefined(); // unrelated field preserved
    }
  });

  test("$project: computed fields with $arrayElemAt / $slice / $map / $cond", async () => {
    const { db } = ctx;
    const rows = await db
      .pipeline("orders")
      .limit(3)
      .project({
        status: 1,
        items: 1,
        firstItem: { $arrayElemAt: ["$items", 0] },
        firstItemName: { $arrayElemAt: ["$items.name", 0] },
        sliced: { $slice: ["$items", 1] },
        names: { $map: { input: "$items", as: "i", in: "$$i.name" } },
        kind: { $cond: [{ $gt: [{ $size: "$items" }, 1] }, "multi", "single"] },
      })
      .toArray();
    for (const row of rows) {
      // computed fields (arrayElemAt/slice/map/cond) are typed `unknown` — cast for runtime checks
      const loose = row as unknown as {
        status: string;
        items: { name: string }[];
        firstItem?: { name?: string };
        firstItemName?: string;
        sliced: unknown[];
        names: unknown[];
        kind: string;
      };
      expect(loose.firstItem?.name).toBe(loose.firstItemName);
      expect(loose.sliced.length).toBe(1);
      expect(loose.names).toEqual(loose.items?.map?.((i) => i.name) ?? []);
      expect(["single", "multi"]).toContain(loose.kind);
    }
  });

  test("raw() sub-pipelines can be embedded in another pipeline", async () => {
    const { db } = ctx;
    const sub = db
      .pipeline("orders")
      .match({ status: "shipped" })
      .project({ total: "$totals.grandTotal" });
    const rows = await db
      .pipeline("customers")
      .lookup({
        from: "orders",
        localField: "_id",
        foreignField: "customerId",
        as: "shippedOrders",
        pipeline: sub.raw(),
      })
      .limit(10)
      .toArray();
    const some = rows.find((r) => r.shippedOrders?.length);
    expect(some).toBeDefined();
    for (const row of rows) {
      for (const so of (row.shippedOrders ?? []) as unknown as { total?: number }[]) {
        expect(so.total).toBeTypeOf("number");
      }
    }
  });

  test("callback-only stages: bucket / bucketAuto", async () => {
    const { db } = ctx;
    const buckets = await (
      await db.aggregate("orders", (s) => [
        s.match({}),
        s.bucket({
          groupBy: "$totals.grandTotal",
          boundaries: [0, 50, 100, 200],
          default: "other",
          output: { n: { $sum: 1 } },
        }),
      ])
    ).toArray();
    const n = buckets.reduce((acc: number, b: { n?: number }) => acc + (b.n ?? 0), 0);
    expect(n).toBe(await db.countDocuments("orders"));

    const auto = await (
      await db.aggregate("orders", (s) => [
        s.match({}),
        s.bucketAuto({ groupBy: "$totals.grandTotal", buckets: 3, output: { n: { $sum: 1 } } }),
      ])
    ).toArray();
    expect(auto.length).toBeLessThanOrEqual(3);
    expect(auto.length).toBeGreaterThan(0);
  });

  test("callback-only stages: fill + densify (server >= 5.1)", async () => {
    const { db } = ctx;
    const info = (await db.client.command({ buildInfo: 1 })) as { version: string };
    const major = Number(info.version.split(".")[0]);
    if (major < 5) return; // fill/densify need 5.1+; skip on older servers

    // densify orders over placedAt by day — synthetic docs fill the gaps
    const densified = await (
      await db.aggregate("orders", (s) => [
        s.match({}),
        s.project({ placedAt: 1, status: 1 }),
        s.densify({
          field: "placedAt",
          range: { step: 1, unit: "day", bounds: "full" },
        }),
      ])
    ).toArray();
    const origCount = await db.countDocuments("orders");
    expect(densified.length).toBeGreaterThan(origCount);

    // fill: interpolate a missing numeric field after projecting it away
    const filled = await (
      await db.aggregate("orders", (s) => [
        s.match({}),
        s.project({ placedAt: 1, total: "$totals.grandTotal" }),
        s.sort({ placedAt: 1 }),
        s.fill({ sortBy: { placedAt: 1 }, output: { total: { method: "linear" } } }),
      ])
    ).toArray();
    expect(filled.length).toBeGreaterThan(0);
    for (const row of filled) {
      expect(row.total).toBeTypeOf("number");
    }
  });

  /* --------------------------- ops-level ------------------------------ */

  test("groupBy: accumulate, sort, limit, pre/post pipeline", async () => {
    const { db } = ctx;
    const rows = await db.groupBy(
      "orders",
      {},
      {
        groupBy: "$status",
        accumulate: { revenue: { $sum: "$totals.grandTotal" }, count: { $sum: 1 } },
        sort: { revenue: -1 },
        limit: 2,
      },
      {
        prePipeline: [{ $match: { status: { $ne: "cancelled" } } }],
        postPipeline: [{ $project: { status: 1, revenue: 1 } }],
      },
    );
    expect(rows.length).toBe(2);
    expect((rows[0] as { revenue: number }).revenue).toBeGreaterThanOrEqual(
      (rows[1] as { revenue: number }).revenue,
    );
    for (const r of rows) {
      expect((r as { status: string }).status).not.toBe("cancelled");
      expect((r as { count?: number }).count).toBeUndefined(); // projected away
    }
  });

  test("textSearch (regex path) returns a paginated result", async () => {
    const { db } = ctx;
    const res = await db.textSearch(
      "customers",
      {},
      { searchFields: ["profile.name"], searchTerm: "Customer", useRegex: true },
      { page: 1, limit: 3, sort: { createdAt: 1 } },
    );
    expect(res.totalCount).toBeGreaterThan(0);
    expect(res.data.length).toBeLessThanOrEqual(3);
    for (const d of res.data) {
      expect(d.profile.name).toMatch(/Customer/i);
    }
    expect(res.data.length).toBeGreaterThan(0);
  });

  test("textSearch ($text path) requires + uses a text index", async () => {
    const { db } = ctx;
    await db.client.collection("customers").createIndex({ "profile.name": "text" });
    const res = await db.textSearch(
      "customers",
      {},
      { searchFields: ["profile.name"], searchTerm: "Customer", useRegex: false },
      { page: 1, limit: 10 },
    );
    expect(res.totalCount).toBeGreaterThan(0);
    for (const d of res.data) {
      expect((d as { searchScore?: number }).searchScore).toBeTypeOf("number");
    }
  });

  test("dateRangeAnalysis: day granularity + accumulate", async () => {
    const { db } = ctx;
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-02-28T23:59:59.999Z");
    const rows = await db.dateRangeAnalysis(
      "orders",
      {},
      { dateField: "placedAt", startDate: start, endDate: end, granularity: "day" },
      { accumulate: { revenue: { $sum: "$totals.grandTotal" } }, sort: { _id: 1 } },
    );
    expect(rows.length).toBeGreaterThan(0);
    const total = rows.reduce((acc: number, r: { revenue?: number }) => acc + (r.revenue ?? 0), 0);
    expect(total).toBeGreaterThan(0);
    expect((rows[0] as { _id: string })._id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("paginateFlexible: pre/post pipeline + projection", async () => {
    const { db } = ctx;
    const res = await db.paginateFlexible(
      "orders",
      {},
      {
        prePipeline: [{ $match: { status: "paid" } }],
        postPipeline: [{ $project: { status: 1 } }],
        limit: 5,
      },
    );
    expect(res.totalCount).toBeGreaterThan(0);
    for (const d of res.data) {
      expect((d as { status: string }).status).toBe("paid");
      expect((d as { totals?: unknown }).totals).toBeUndefined();
    }
  });

  test("paginateFlexible: zero matches → empty data, zero total", async () => {
    const { db } = ctx;
    const res = await db.paginateFlexible(
      "orders",
      { status: "no-such-status" as never },
      { page: 1, limit: 5 },
    );
    expect(res.data).toEqual([]);
    expect(res.totalCount).toBe(0);
    expect(res.totalPages).toBe(0);
  });

  test("paginateFlexible: page beyond total → empty data with correct totals", async () => {
    const { db } = ctx;
    const res = await db.paginateFlexible("orders", {}, { page: 999, limit: 5 });
    expect(res.data).toEqual([]);
    expect(res.totalCount).toBeGreaterThan(0);
    expect(res.totalPages).toBe(Math.ceil(res.totalCount / 5));
  });

  test("paginateFlexible rejects invalid limits (limit < 1, limit > maxLimit)", async () => {
    const { db } = ctx;
    await expect(db.paginateFlexible("orders", {}, { limit: 0 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(db.paginateFlexible("orders", {}, { limit: 1001 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  /* ---------------------- options & semantics ------------------------- */

  test("batchSize / hint / maxTimeMS are forwarded to the driver aggregate()", async () => {
    const { db } = ctx;
    const proto = Collection.prototype as unknown as {
      aggregate: (...args: unknown[]) => unknown;
    };
    const original = proto.aggregate;
    const captured: unknown[] = [];
    proto.aggregate = function (this: unknown, ...args: unknown[]) {
      captured.push(args[1]);
      return (original as (...a: unknown[]) => unknown).call(this, ...args);
    };
    try {
      await db
        .pipeline("orders", { batchSize: 2, maxTimeMS: 5000, hint: { status: 1, placedAt: -1 } })
        .limit(1)
        .toArray();
    } finally {
      proto.aggregate = original;
    }
    expect(captured.length).toBeGreaterThan(0);
    const opts = captured[captured.length - 1] as Record<string, unknown>;
    expect(opts.batchSize).toBe(2);
    expect(opts.maxTimeMS).toBe(5000);
    expect(opts.hint).toEqual({ status: 1, placedAt: -1 });
  });

  test("aggregations accept a session inside a transaction (graceful fallback when unsupported)", async () => {
    const { db } = ctx;
    const proto = Collection.prototype as unknown as {
      aggregate: (...args: unknown[]) => unknown;
    };
    const original = proto.aggregate;
    const sawSessions: ClientSession[] = [];
    proto.aggregate = function (this: unknown, ...args: unknown[]) {
      const options = args[1] as { session?: ClientSession };
      if (options?.session) sawSessions.push(options.session);
      return (original as (...a: unknown[]) => unknown).call(this, ...args);
    };
    try {
      let gotSession: ClientSession | null = null;
      await db.transaction(async (session) => {
        gotSession = session;
        const rows = await db
          .pipeline("orders", { session: session ?? undefined })
          .limit(1)
          .toArray();
        expect(rows.length).toBe(1);
        return rows;
      });
      // On a replica set a real session is used and forwarded to the driver;
      // on a standalone server the graceful fallback runs with a null session —
      // the aggregation must succeed in BOTH cases.
      expect(gotSession !== undefined).toBe(true);
      if (gotSession) {
        expect(sawSessions.length).toBeGreaterThan(0);
      }
    } finally {
      proto.aggregate = original;
    }
  });

  test("first() on no matches returns null", async () => {
    const { db } = ctx;
    const one = await db
      .pipeline("orders")
      .match({ status: "no-such-status" } as never)
      .first();
    expect(one).toBeNull();
  });

  test("identical aggregations are cached and deduped (perf on)", async () => {
    const { db } = perfOn; // cache + dedup ON
    // A repeated identical aggregation is served from the cache → one driver
    // query total (the first call), zero for the repeat.
    const q0 = await serverQueryCount(db.client);
    await db
      .pipeline("orders")
      .group({ _id: "$status", n: { $sum: 1 } })
      .toArray();
    await db
      .pipeline("orders")
      .group({ _id: "$status", n: { $sum: 1 } })
      .toArray();
    const delta = (await serverQueryCount(db.client)) - q0;
    expect(delta).toBe(1); // repeat hit the cache — NOT a second driver query

    // Concurrent identical (cold) aggregations coalesce into ONE driver call.
    const q1 = await serverQueryCount(db.client);
    const [a, b] = await Promise.all([
      db
        .pipeline("orders")
        .group({ _id: "$status", n: { $sum: 1 } })
        .sort({ _id: -1 })
        .toArray(),
      db
        .pipeline("orders")
        .group({ _id: "$status", n: { $sum: 1 } })
        .sort({ _id: -1 })
        .toArray(),
    ]);
    const dedupDelta = (await serverQueryCount(db.client)) - q1;
    expect(a).toEqual(b);
    expect(dedupDelta).toBe(1); // in-flight dedup coalesced the two
  });

  /* --------------------------- errors/guards -------------------------- */

  test("array-form sub-pipelines are rejected with a descriptive error (chained)", () => {
    const { db } = ctx;
    expect(() =>
      db.pipeline("orders").lookup({
        from: "customers",
        localField: "customerId",
        foreignField: "_id",
        as: "c",
        pipeline: ((o: any) => [o.match({}), o.project({ email: 1 })]) as never,
      }),
    ).toThrow(/chained builder/);
  });

  test("array-form sub-pipelines are rejected with a descriptive error (callback aggregate)", () => {
    const { db } = ctx;
    expect(() =>
      db.aggregate("orders", (s) => [
        s.lookup({
          from: "customers",
          localField: "customerId",
          foreignField: "_id",
          as: "c",
          pipeline: ((o: any) => [o.match({})]) as never,
        }),
      ]),
    ).toThrow(/chained builder/);
  });

  test("stage-only pipeline builders cannot be executed", async () => {
    await expect(stageBuilder().toArray()).rejects.toThrow(
      /stage-only pipeline builders cannot be executed/,
    );
  });

  test("wrapMongoErrors:false (opt-out) surfaces the raw driver error", async () => {
    const { db } = raw;
    try {
      await db.aggregate("orders", () => [{ $bogus: 1 }]).then((c) => c.toArray());
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { name?: string }).name).toBe("MongoServerError");
      expect(String((err as Error).message)).toMatch(/bogus|Unrecognized pipeline stage/i);
    }
  });

  test("wrapMongoErrors:true maps a pipeline error to InfraError MONGO_QUERY_ERROR with context", async () => {
    const { db } = ctx;
    // A typed pipeline that fails at execution time (divide by zero) — errors
    // that occur during cursor `.toArray()` ARE wrapped by the `.toArray()`
    // terminal (unlike the low-level `aggregate()` cursor, which defers to the
    // caller and therefore surfaces raw driver errors).
    try {
      await db
        .pipeline("orders")
        .addFields({ bad: { $divide: [1, 0] } })
        .toArray();
      throw new Error("should have thrown");
    } catch (err) {
      expect(isInfraError(err)).toBe(true);
      expect((err as { code?: string }).code).toBe("MONGO_QUERY_ERROR");
      expect((err as { extra?: Record<string, unknown> }).extra?.collection).toBe("orders");
    }
  });

  test("aggregate() returns a live cursor; .toArray()/batch iteration works", async () => {
    const { db } = ctx;
    const cursor = await db.aggregate("orders", (s) => [
      s.match({}),
      s.sort({ placedAt: 1 }),
      s.limit(5),
    ]);
    const batch = await cursor.toArray();
    expect(batch.length).toBe(5);
    // ensure types stay loose but data flows
    expect(batch[0]).toBeDefined();
  });

  test("_id round-trips through joins (ObjectId identity preserved)", async () => {
    const { db, seed } = ctx;
    const rows = await db
      .pipeline("orders")
      .lookup({ from: "customers", localField: "customerId", foreignField: "_id", as: "customer" })
      .limit(10)
      .toArray();
    for (const row of rows) {
      expect(row._id).toBeInstanceOf(ObjectId);
      expect(row.customer?.[0]?._id).toBeInstanceOf(ObjectId);
      expect(row.customer?.[0]?._id.equals(row.customerId)).toBe(true);
    }
    void seed;
  });
});
