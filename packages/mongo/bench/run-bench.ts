/**
 * Performance harness for ninox optimizations.
 *
 * Runs against a local MongoDB (see .env). Compares the optimized paths against
 * naive baselines and writes a summary to bench/results/summary.json.
 *
 *   bun run bench
 *
 * Scenarios:
 *   a. DataLoader population   (naive N+1 findOne vs 1 batched $in query)
 *   b. $facet pagination       (count + find = 2 RT vs 1 RT)
 *   c. Query cache             (cold driver read vs cache hit = 0 driver calls)
 *   d. In-flight dedup         (N concurrent identical reads → server query count)
 *   e. bulkWrite               (insertMany vs bulkUpsert)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectId } from "mongodb";
import { QueryCache } from "../src/cache/query-cache.ts";
import { belongsTo } from "../src/relation/relation.ts";
import { s } from "../src/schema/index.ts";
import { createMongoService } from "../src/service/index.ts";
import {
  type EnterpriseDb,
  type EnterpriseScale,
  enterpriseCollections,
  seedEnterprise,
} from "../tests/fixtures/enterprise.ts";

const MONGO_URL = process.env.MONGO_URL ?? "mongodb://admin:admin@localhost:27017/";
const DB_NAME = "ninox_orm_bench";
const NOOP = { debug() {}, info() {}, warn() {}, error() {} };

const userSchema = s.object({
  _id: s.objectId(),
  email: s.string(),
  role: s.string(),
  createdAt: s.date(),
});
const orderSchema = s.object({
  _id: s.objectId(),
  userId: s.objectId(),
  total: s.number(),
  status: s.string(),
});

type Result = {
  name: string;
  opsPerSec: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p999Ms: number;
  driverQueries?: number;
};

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? sorted.at(-1) ?? 0;

/** Warmup + sample, returns per-op timings in ms. */
const sample = async (
  fn: () => Promise<unknown>,
  { warmup = 20, iterations = 150 } = {},
): Promise<number[]> => {
  for (let i = 0; i < warmup; i++) await fn();
  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    timings.push(performance.now() - start);
  }
  return timings;
};

const bench = async (
  name: string,
  fn: () => Promise<unknown>,
  driverQueries?: number,
): Promise<Result> => {
  const timings = await sample(fn);
  timings.sort((a, b) => a - b);
  const meanMs = timings.reduce((a, b) => a + b, 0) / timings.length;
  return {
    name,
    opsPerSec: 1000 / meanMs,
    minMs: timings[0] ?? 0,
    meanMs,
    p50Ms: pct(timings, 0.5),
    p95Ms: pct(timings, 0.95),
    p999Ms: pct(timings, 0.999),
    ...(driverQueries !== undefined ? { driverQueries } : {}),
  };
};

const serverQueryCount = async (db: unknown): Promise<number> => {
  // Accept either a collection manager ({ client: Db }) or a raw Db handle.
  const handle = ((db as { client?: unknown }).client ?? db) as {
    admin(): { command(c: Record<string, unknown>): Promise<unknown> };
  };
  const status = (await handle.admin().command({ serverStatus: 1 })) as {
    opcounters?: { query?: number };
  };
  return status.opcounters?.query ?? 0;
};

/**
 * Bench services explicitly opt OUT of the now-default cache + dedup so each
 * scenario measures what it intends (naive baselines stay naive; the cache and
 * dedup scenarios enable exactly the feature under test).
 */
const createService = (options: { cache?: QueryCache; dedupeReads?: boolean } = {}) =>
  createMongoService(
    {
      primary: {
        name: DB_NAME,
        dbUrl: MONGO_URL,
        collections: { users: userSchema, orders: orderSchema },
      },
    },
    {
      logger: NOOP,
      cache: options.cache ?? null,
      dedupeReads: options.dedupeReads ?? false,
    },
  );

const run = async (): Promise<void> => {
  const service = createService();
  await service.makeConnections();
  const db = service.db.primaryClient;
  await db.client.dropCollection("users").catch(() => {});
  await db.client.dropCollection("orders").catch(() => {});
  await db.createSchema("users");
  await db.createSchema("orders");

  // Seed: 200 users, 1000 orders.
  const users = Array.from({ length: 200 }, (_, i) => ({
    email: `user${i}@example.com`,
    role: i % 3 === 0 ? "admin" : "user",
    createdAt: new Date(),
  }));
  const inserted = await db.insertMany("users", users);
  const userIds = Object.values(inserted.insertedIds);
  const orders = Array.from({ length: 1000 }, (_, i) => ({
    userId: userIds[i % userIds.length]!,
    total: (i % 500) + 0.99,
    status: i % 2 === 0 ? "paid" : "pending",
  }));
  await db.insertMany("orders", orders);

  const results: Result[] = [];
  const allServices: Array<{ closeConnections(): Promise<void> }> = [];

  // ---- (a) DataLoader population vs naive N+1 ----
  const sampleOrders = await db.findMany("orders", {}, { limit: 100 });
  const sampleIds = userIds.slice(0, 100);

  const naivePopulate = async () => {
    for (const order of sampleOrders) {
      await db.getOne("users", { _id: (order as { userId: ObjectId }).userId });
    }
  };
  const loaderPopulate = async () => {
    const docs = await db.findMany("orders", {}, { limit: 100 });
    await db.populate(docs, [belongsTo({ collection: "users", localField: "userId", as: "user" })]);
  };

  const qBeforeNaive = await serverQueryCount(db);
  results.push(await bench("a. population: naive N+1 (100 findOne)", naivePopulate));
  const qAfterNaive = await serverQueryCount(db);

  const qBeforeLoader = await serverQueryCount(db);
  results.push(await bench("a. population: DataLoader batched $in", loaderPopulate));
  const qAfterLoader = await serverQueryCount(db);

  results[results.length - 2]!.driverQueries = qAfterNaive - qBeforeNaive;
  results[results.length - 1]!.driverQueries = qAfterLoader - qBeforeLoader;

  // ---- (b) $facet pagination vs count + find ----
  const naivePage = async () => {
    await db.countDocuments("orders", { status: "paid" });
    await db.findMany("orders", { status: "paid" }, { skip: 100, limit: 10 });
  };
  const facetPage = async () => {
    await db.paginateFlexible(
      "orders",
      { status: "paid" },
      { page: 11, limit: 10, sort: { total: -1 } },
    );
  };

  const qBeforeNaivePage = await serverQueryCount(db);
  results.push(await bench("b. pagination: count + find (2 RT)", naivePage));
  const qAfterNaivePage = await serverQueryCount(db);

  const qBeforeFacet = await serverQueryCount(db);
  results.push(await bench("b. pagination: $facet single RT", facetPage));
  const qAfterFacet = await serverQueryCount(db);

  results[results.length - 2]!.driverQueries = qAfterNaivePage - qBeforeNaivePage;
  results[results.length - 1]!.driverQueries = qAfterFacet - qBeforeFacet;

  allServices.push(service);

  // ---- (c) Query cache: cold vs cache hit ----
  const cachedService = createService({ cache: new QueryCache({ maxSize: 1000 }) });
  await cachedService.makeConnections();
  const cachedDb = cachedService.db.primaryClient;

  results.push(
    await bench("c. cache: cold driver read", () =>
      cachedDb.findMany("orders", { status: "paid" }, { limit: 50 }),
    ),
  );
  await cachedDb.findMany("orders", { status: "paid" }, { limit: 50 }); // warm
  results.push(
    await bench(
      "c. cache: cache hit (0 driver calls)",
      () => cachedDb.findMany("orders", { status: "paid" }, { limit: 50 }),
      0,
    ),
  );
  allServices.push(cachedService);

  // ---- (d) In-flight dedup: server query count under concurrency ----
  const dedupOff = createService();
  const dedupOn = createService({ dedupeReads: true });
  await dedupOff.makeConnections();
  await dedupOn.makeConnections();
  const offDb = dedupOff.db.primaryClient;
  const onDb = dedupOn.db.primaryClient;

  const fire = (db: typeof offDb, n: number) =>
    Promise.all(Array.from({ length: n }, () => db.countDocuments("orders", { status: "paid" })));

  const q0 = await serverQueryCount(dedupOff.db.primaryClient);
  const t0 = performance.now();
  await fire(offDb, 50);
  const elapsedOff = performance.now() - t0;
  const q1 = await serverQueryCount(dedupOff.db.primaryClient);

  const q2 = await serverQueryCount(dedupOn.db.primaryClient);
  const t1 = performance.now();
  await fire(onDb, 50);
  const elapsedOn = performance.now() - t1;
  const q3 = await serverQueryCount(dedupOn.db.primaryClient);

  results.push({
    name: "d. dedup: 50 concurrent identical reads (off)",
    opsPerSec: 50 / (elapsedOff / 1000),
    minMs: elapsedOff,
    meanMs: elapsedOff,
    p50Ms: elapsedOff,
    p95Ms: elapsedOff,
    p999Ms: elapsedOff,
    driverQueries: q1 - q0,
  });
  results.push({
    name: "d. dedup: 50 concurrent identical reads (on)",
    opsPerSec: 50 / (elapsedOn / 1000),
    minMs: elapsedOn,
    meanMs: elapsedOn,
    p50Ms: elapsedOn,
    p95Ms: elapsedOn,
    p999Ms: elapsedOn,
    driverQueries: q3 - q2,
  });

  allServices.push(dedupOff, dedupOn);

  // ---- (e) bulkWrite: insertMany vs bulkUpsert ----
  const bulkService = createService();
  await bulkService.makeConnections();
  const bulkDb = bulkService.db.primaryClient;

  const batchUsers = () =>
    Array.from({ length: 100 }, (_, _i) => ({
      email: `bulk${Math.floor(Math.random() * 50)}@example.com`,
      role: "user",
      createdAt: new Date(),
    }));

  const insertManyRun = async () => {
    await bulkDb.insertMany("users", batchUsers());
  };
  const bulkUpsertRun = async () => {
    await bulkDb.bulkUpsert(
      "users",
      Array.from({ length: 100 }, (_, i) => ({
        filter: { email: `bulk${i % 50}@example.com` },
        update: { $set: { role: "user", createdAt: new Date() } },
      })),
    );
  };

  results.push(await bench("e. write: insertMany (100 docs)", insertManyRun));
  results.push(await bench("e. write: bulkUpsert (100 ops)", bulkUpsertRun));
  allServices.push(bulkService);

  // ---- (f) complex multistage aggregation (enterprise model at scale) ----
  const aggService = createMongoService(
    {
      primary: { name: `${DB_NAME}_agg`, dbUrl: MONGO_URL, collections: enterpriseCollections },
    },
    { logger: NOOP, cache: null, dedupeReads: false },
  );
  await aggService.makeConnections();
  const aggDb = aggService.db.primaryClient;
  const aggScale: EnterpriseScale = {
    customers: 200,
    products: 100,
    ordersPerCustomer: 5, // 1000 orders
    reviews: 200,
  };
  await seedEnterprise(aggDb as unknown as EnterpriseDb, aggScale);
  allServices.push(aggService);

  const multiLookup = () =>
    aggDb
      .pipeline("orders")
      .lookup({ from: "customers", localField: "customerId", foreignField: "_id", as: "customer" })
      .lookup({ from: "shipments", localField: "_id", foreignField: "orderId", as: "shipments" })
      .limit(50)
      .toArray();

  const deepPipeline = () =>
    aggDb
      .pipeline("orders")
      .lookup({ from: "customers", localField: "customerId", foreignField: "_id", as: "customer" })
      .unwind("$items")
      .group({
        _id: { sku: "$items.sku", status: "$status" },
        qty: { $sum: "$items.qty" },
        revenue: { $sum: { $multiply: ["$items.qty", "$items.unitPrice"] } },
      })
      .sort({ revenue: -1 })
      .limit(20)
      .toArray();

  const qBf = await serverQueryCount(aggDb);
  results.push(await bench("f. agg: multi-lookup join (orders→customers→shipments)", multiLookup));
  const qAf = await serverQueryCount(aggDb);
  results[results.length - 1]!.driverQueries = qAf - qBf;

  const qBd = await serverQueryCount(aggDb);
  results.push(await bench("f. agg: deep pipeline (lookup + unwind + group + sort)", deepPipeline));
  const qAd = await serverQueryCount(aggDb);
  results[results.length - 1]!.driverQueries = qAd - qBd;

  // naive N+1 baseline for the same join
  const naiveOrders = await aggDb.findMany("orders", {}, { limit: 100 });
  const naiveJoin = async () => {
    for (const order of naiveOrders) {
      await aggDb.findMany(
        "customers",
        { _id: (order as { customerId: ObjectId }).customerId },
        { limit: 1 },
      );
    }
  };
  const qBn = await serverQueryCount(aggDb);
  results.push(await bench("f. agg: naive N+1 join (100 findMany)", naiveJoin));
  const qAn = await serverQueryCount(aggDb);
  results[results.length - 1]!.driverQueries = qAn - qBn;

  const groupByRun = () =>
    aggDb.groupBy(
      "orders",
      { status: { $ne: "cancelled" } },
      {
        groupBy: "$status",
        accumulate: { revenue: { $sum: "$totals.grandTotal" }, count: { $sum: 1 } },
        sort: { revenue: -1 },
      },
    );
  results.push(await bench("f. agg: groupBy (revenue per status)", groupByRun));

  const dateRangeRun = () =>
    aggDb.dateRangeAnalysis(
      "orders",
      {},
      {
        dateField: "placedAt",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: new Date("2026-04-30T23:59:59.999Z"),
        granularity: "day",
      },
      { accumulate: { revenue: { $sum: "$totals.grandTotal" } }, sort: { _id: 1 } },
    );
  results.push(await bench("f. agg: dateRangeAnalysis (daily revenue)", dateRangeRun));

  const deepPage = async () => {
    await aggDb.paginateFlexible("orders", {}, { page: 91, limit: 10, sort: { placedAt: -1 } });
  };
  const qBp = await serverQueryCount(aggDb);
  results.push(await bench("f. agg: $facet deep-page pagination (skip ~900)", deepPage));
  const qAp = await serverQueryCount(aggDb);
  results[results.length - 1]!.driverQueries = qAp - qBp;

  // ---- report ----
  const outDir = join(import.meta.dir, "results");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "summary.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
  );

  console.log("\nninox benchmark results");
  console.log("================================");
  console.log(
    "name".padEnd(48),
    "ops/s".padStart(10),
    "p50(ms)".padStart(9),
    "p95(ms)".padStart(9),
    "queries".padStart(8),
  );
  for (const r of results) {
    console.log(
      r.name.padEnd(48),
      r.opsPerSec.toFixed(0).padStart(10),
      r.p50Ms.toFixed(3).padStart(9),
      r.p95Ms.toFixed(3).padStart(9),
      (r.driverQueries !== undefined ? String(r.driverQueries) : "-").padStart(8),
    );
  }
  console.log("\nsummary written to bench/results/summary.json");

  // Graceful shutdown. Results are already persisted above — never let a driver
  // teardown race (checked-out connection at close) crash the run.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await Promise.allSettled(
    allServices.map((svc) =>
      Promise.resolve()
        .then(() => svc.closeConnections())
        .catch(() => {}),
    ),
  );
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Force a clean exit so lingering driver handles never surface teardown errors.
    setTimeout(() => process.exit(process.exitCode ?? 0), 50);
  });
