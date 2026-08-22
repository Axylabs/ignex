/**
 * Performance-regression suite for complex aggregations (real MongoDB).
 *
 * The enterprise model is seeded at a moderate scale and the server query
 * counter (`opcounters.query`) is used to prove the ORM's aggregation paths are
 * single-round-trip — that a multi-stage pipeline (multi-lookup + unwind +
 * group + facet) and `$facet` pagination each execute as ONE driver query, and
 * that the aggregation path avoids the N+1 a naive findMany loop would cost.
 * It also pins parity between perf-on and perf-off configurations.
 *
 * Deliberately asserts SERVER QUERY COUNTS, not wall-clock time — deterministic
 * and flake-free. Guarded by a local MongoDB.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
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

maybe("complex aggregation performance (query counts, real MongoDB)", () => {
  let perfOn: EnterpriseServiceContext; // cache + dedup + all optimizations ON
  let perfOff: EnterpriseServiceContext; // perf: false

  beforeAll(async () => {
    const scale = { customers: 8, products: 12, ordersPerCustomer: 10, reviews: 30 };
    perfOn = await makeEnterpriseService("ninox_agg_perf_on", { scale });
    perfOff = await makeEnterpriseService("ninox_agg_perf_off", { scale, perf: false });
  });

  afterAll(async () => {
    await closeService(perfOn);
    await closeService(perfOff);
  });

  const complexPipeline = (db: EnterpriseServiceContext["db"]) =>
    db
      .pipeline("orders")
      .lookup({ from: "customers", localField: "customerId", foreignField: "_id", as: "customer" })
      .lookup({ from: "shipments", localField: "_id", foreignField: "orderId", as: "shipments" })
      .unwind("$items")
      .group({
        _id: { sku: "$items.sku", status: "$status" },
        qty: { $sum: "$items.qty" },
        revenue: { $sum: { $multiply: ["$items.qty", "$items.unitPrice"] } },
      })
      .sort({ revenue: -1 })
      .limit(20)
      .toArray();

  test("a multi-stage pipeline (2 lookups + unwind + group + sort) is ONE driver query", async () => {
    const { db } = perfOn;
    const q0 = await serverQueryCount(db.client);
    const rows = await complexPipeline(db);
    const delta = (await serverQueryCount(db.client)) - q0;
    expect(rows.length).toBeGreaterThan(0);
    expect(delta).toBe(1);
  });

  test("$facet pagination is ONE driver query", async () => {
    const { db } = perfOn;
    const q0 = await serverQueryCount(db.client);
    const page = await db.paginateFlexible(
      "orders",
      {},
      { page: 1, limit: 10, sort: { placedAt: -1 } },
    );
    const delta = (await serverQueryCount(db.client)) - q0;
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.totalCount).toBeGreaterThan(0);
    expect(delta).toBe(1);
  });

  test("aggregation avoids the N+1 of a naive findMany loop", async () => {
    const { db } = perfOn;
    const orderCount = await db.countDocuments("orders");

    // naive: load every order, then one query per order to fetch its customer
    const q0 = await serverQueryCount(db.client);
    const orders = await db.findMany("orders", {}, { limit: 1000 });
    const seen = new Map<string, boolean>();
    for (const o of orders) {
      const key = String(o.customerId);
      if (!seen.has(key)) {
        seen.set(key, true);
        await db.findMany("customers", { _id: o.customerId }, { limit: 1 });
      }
    }
    const naiveDelta = (await serverQueryCount(db.client)) - q0;
    // dedup is on, but the driver still issues one query per unique customer
    expect(naiveDelta).toBe(1 + seen.size);

    // optimized: a single $lookup
    const q1 = await serverQueryCount(db.client);
    await db
      .pipeline("orders")
      .limit(orderCount)
      .lookup({ from: "customers", localField: "customerId", foreignField: "_id", as: "customer" })
      .toArray();
    const aggDelta = (await serverQueryCount(db.client)) - q1;
    expect(aggDelta).toBe(1);
    expect(aggDelta).toBeLessThan(naiveDelta);
  });

  test("perf-on and perf-off produce IDENTICAL results for a complex pipeline", async () => {
    const on = await complexPipeline(perfOn.db);
    const off = await complexPipeline(perfOff.db);
    expect(on.length).toBe(off.length);
    expect(on.length).toBeGreaterThan(0);
    // `$sort` ties (equal revenue) have non-deterministic order across runs, so
    // canonicalize by compound _id before comparing — the DATA must be identical.
    const canon = (rows: unknown[]) =>
      [...rows].sort((a: unknown, b: unknown) => {
        const ka = `${(a as { _id: { status: string; sku: string } })._id.status}\u0000${(a as { _id: { status: string; sku: string } })._id.sku}`;
        const kb = `${(b as { _id: { status: string; sku: string } })._id.status}\u0000${(b as { _id: { status: string; sku: string } })._id.sku}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
    expect(canon(on)).toEqual(canon(off));
  });

  test("deep multi-collection join at scale stays a single query", async () => {
    const { db } = perfOn;
    const q0 = await serverQueryCount(db.client);
    const rows = await db
      .pipeline("orders")
      .lookup({ from: "customers", localField: "customerId", foreignField: "_id", as: "customer" })
      .lookup({ from: "shipments", localField: "_id", foreignField: "orderId", as: "shipments" })
      .facet({
        byStatus: (s) => s.group({ _id: "$status", n: { $sum: 1 } }),
        withCustomer: (s) =>
          s
            .lookup({ from: "customers", localField: "customerId", foreignField: "_id", as: "c" })
            .limit(3),
      })
      .toArray();
    const delta = (await serverQueryCount(db.client)) - q0;
    expect(rows.length).toBeGreaterThan(0);
    expect(delta).toBe(1);
  });
});
