/**
 * Fully type-safe aggregation pipeline — `db.pipeline()`.
 *
 * Every stage is typed against the current document shape, `$lookup`
 * sub-pipelines are scoped to the related collection's schema, `$facet`
 * branches get typed sub-builders, and the result type of `.toArray()` /
 * `.first()` is inferred through the whole chain. The callback `db.aggregate()`
 * stages are collection-typed too.
 *
 *   bun run examples/10-typed-pipeline.ts
 */
import { close, connect } from "./shared/setup.ts";

const DB = "ninox_examples_10_typed_pipeline";

const run = async () => {
  const ctx = await connect(DB);
  const { db } = ctx;

  // Seed a user + a few orders.
  const { insertedId: userId } = await db.insertOne("users", {
    email: "shop@example.com",
    name: "Shop Owner",
    role: "admin",
    createdAt: new Date(),
  });
  const now = Date.now();
  await db.insertMany("orders", [
    { userId, total: 120, status: "paid", createdAt: new Date(now - 1 * 86400000) },
    { userId, total: 40, status: "pending", createdAt: new Date(now - 2 * 86400000) },
    { userId, total: 250, status: "shipped", createdAt: new Date(now - 3 * 86400000) },
  ]);

  // 1) Chained pipeline with an inferred result type.
  //    `byStatus[0]` is { _id: 'paid' | 'shipped'; revenue: number; count: number }.
  const byStatus = await db
    .pipeline("orders")
    .match({ status: { $in: ["paid", "shipped"] } })
    .group({ _id: "$status", revenue: { $sum: "$total" }, count: { $sum: 1 } })
    .sort({ revenue: -1 })
    .toArray();
  console.log("revenue by status:", JSON.stringify(byStatus));

  // 2) `$lookup` sub-pipeline scoped to the related collection.
  //    Inside the callback, `o` autocompletes Order fields and the `orders` field
  //    is typed as the sub-pipeline output: Array<{ _id; total; status }>.
  const withOrders = await db
    .pipeline("users")
    .lookup({
      from: "orders",
      localField: "_id",
      foreignField: "userId",
      as: "orders",
      pipeline: (o) => o.match({ total: { $gte: 50 } }).project({ total: 1, status: 1 }),
    })
    .toArray();
  console.log("user with matching orders:", JSON.stringify(withOrders[0]));

  // 3) `$facet` — each branch gets its own typed sub-builder and the output is
  //    { byStatus: Array<{ _id; count }>; top3: Order[] }.
  const faceted = await db
    .pipeline("orders")
    .facet({
      byStatus: (s) => s.group({ _id: "$status", count: { $sum: 1 } }),
      top3: (s) => s.sort({ total: -1 }).limit(3),
    })
    .toArray();
  console.log("facet:", JSON.stringify(faceted[0]));

  // 4) The callback `aggregate()` stages are collection-typed too.
  const cursor = await db.aggregate("orders", (stages) => [
    stages.match({ status: "paid" }),
    stages.group({ _id: "$userId", total: { $sum: "$total" } }),
    stages.sort({ total: -1 }),
    stages.limit(3),
  ]);
  const top = await cursor.toArray();
  console.log("top paid totals:", JSON.stringify(top));

  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
