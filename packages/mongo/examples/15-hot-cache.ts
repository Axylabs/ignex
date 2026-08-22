/**
 * HotCache — the global, opt-in read-through LRU cache for latency-sensitive,
 * high-throughput workloads that can't afford a DB round-trip per read.
 *
 *   bun run examples/15-hot-cache.ts
 *
 * A single global `createHotCache()` instance registers ("opts in") hot
 * queries; the parameters of each call become the cache key. Reads hit a
 * per-query LRU, so repeated calls never touch the DB. Keeping the cache fresh
 * depends on the deployment (auto-detected by probing the server):
 *   - replica set / mongos → change-stream watchers invalidate bound queries
 *     the moment a write lands — even from other processes
 *   - standalone (no change streams) → a global ticker background-refreshes
 *     entries at `refreshIntervalMs` (bounded staleness, reads never block)
 *
 * Query counts come from `serverStatus.opcounters.query`.
 */
import { ObjectId } from "mongodb";
import { probeMongoCapabilities } from "../src/capabilities.ts";
import { createHotCache } from "../src/index.ts";
import { close, connect } from "./shared/setup.ts";

const DB = "ninox_examples_15_hot_cache";

const serverQueryCount = async (db: {
  client: {
    admin(): {
      command(c: Record<string, unknown>): Promise<{ opcounters?: { query?: number } }>;
    };
  };
}) => {
  const status = await db.client.admin().command({ serverStatus: 1 });
  return status.opcounters?.query ?? 0;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  const ctx = await connect(DB);
  const { db } = ctx;

  // Seed a little data.
  await db.insertMany("products", [
    { sku: "A-1", name: "Coffee", price: 4.5 },
    { sku: "A-2", name: "Tea", price: 3.2 },
    { sku: "B-1", name: "Mug", price: 9.0 },
  ]);
  await db.insertOne("users", {
    email: "ada@example.com",
    name: "Ada",
    role: "admin",
    createdAt: new Date(),
  });

  // One global instance for the whole process.
  const hot = createHotCache({
    // Auto-detect: replicas → change streams, standalone → ticker.
    probe: async () => (await probeMongoCapabilities(db.client)).transactionsSupported,
    tickIntervalMs: 500,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  // Opt in the queries that must NOT hit the DB on every request.
  const topProducts = hot.register("topProducts", {
    loader: async (limit: number) => db.findMany("products", {}, { limit }),
    // Physical collection names (no prefix on this DB → same as logical).
    watch: [{ db: db.client, collection: "products" }],
  });
  const userByEmail = hot.register("userByEmail", {
    loader: async (email: string) => db.getOne("users", { email }),
    watch: [{ db: db.client, collection: "users" }],
  });
  // Raw loader (bypasses the ORM's own QueryCache) so query counts are clean.
  const orderStats = hot.register("orderStats", {
    refreshIntervalMs: 300, // standalone: the ticker keeps this fresh
    loader: async () => db.client.collection("orders").countDocuments(),
    watch: [{ db: db.client, collection: "orders" }],
  });

  const mode = await hot.start();
  console.log("hot cache mode:", mode, mode === "replica" ? "(change streams)" : "(ticker)");

  // 1) Read-through: cold load hits the DB, warm reads are served from LRU.
  let q0 = await serverQueryCount(db);
  await topProducts.get(3);
  let q1 = await serverQueryCount(db);
  await topProducts.get(3); // warm
  let q2 = await serverQueryCount(db);
  console.log("topProducts: cold =", q1 - q0, "driver query | warm =", q2 - q1, "queries");

  // 2) Parameters become the cache key.
  q0 = await serverQueryCount(db);
  await userByEmail.get("ada@example.com");
  q1 = await serverQueryCount(db);
  await userByEmail.get("ada@example.com"); // same email → cached
  q2 = await serverQueryCount(db);
  console.log("userByEmail: first =", q1 - q0, "query | repeated =", q2 - q1, "queries");

  // 3) Manual invalidation — full control over staleness.
  // A raw loader (bypasses the ORM's own QueryCache) keeps reload counts clean.
  const manualCount = hot.register("manualCount", {
    loader: async () => db.client.collection("products").countDocuments(),
  });
  await manualCount.get(); // cold → count cached
  manualCount.invalidate(); // drop all entries → next read reloads
  q2 = await serverQueryCount(db);
  await manualCount.get(); // reloaded → back to the DB
  const q3 = await serverQueryCount(db);
  console.log("manual invalidate: after invalidate(), reload =", q3 - q2, "query");

  // Param-level drop — the accessor types the parameters for intellisense.
  userByEmail.invalidate("ada@example.com"); // drop just this email's entry
  topProducts.invalidate(3); // drop just the { limit: 3 } entry

  if (mode === "standalone") {
    // 4a) Standalone: no change streams → the global ticker refreshes the entry.
    await orderStats.get(); // 0, now cached
    await db.insertOne("orders", {
      userId: new ObjectId(),
      total: 12.5,
      status: "paid",
      createdAt: new Date(),
    });
    console.log(
      "DB now has 1 order; hot cache still returns:",
      await orderStats.get(),
      "(stale until the ticker refreshes)",
    );
    await sleep(1100); // let the ticker swap in the fresh value
    console.log("hot cache after ticker  :", await orderStats.get(), "(refreshed to 1)");
  } else {
    // 4b) Replica: a change stream invalidates the cache on external writes.
    q0 = await serverQueryCount(db);
    const cached = await orderStats.get();
    q1 = await serverQueryCount(db);
    await db.client
      .collection("orders")
      .insertOne({ userId: new ObjectId(), total: 5, status: "pending", createdAt: new Date() });
    // Change-stream delivery is async — poll until the loader re-runs.
    let q = q1;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await orderStats.get();
      q = await serverQueryCount(db);
      if (q > q1) break;
      await sleep(50);
    }
    console.log(
      "orderStats: cached =",
      cached,
      "| after external insert + change stream, fresh count =",
      await orderStats.get(),
      `(${q - q1} new driver query)`,
    );
  }

  await hot.stop();
  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
