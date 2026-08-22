/**
 * Aggregation — typed stage builder plus `groupBy` / `dateRangeAnalysis`.
 *
 *   bun run examples/07-aggregation.ts
 */
import { close, connect } from "./shared/setup.ts";

const DB = "ninox_examples_07_aggregation";

const run = async () => {
  const ctx = await connect(DB);
  const { db } = ctx;

  const { insertedId: userId } = await db.insertOne("users", {
    email: "shop@example.com",
    role: "user",
    createdAt: new Date(),
  });
  const now = Date.now();
  await db.insertMany(
    "orders",
    Array.from({ length: 30 }, (_, i) => ({
      userId,
      total: (i % 10) + 0.5,
      status: i % 3 === 0 ? "shipped" : i % 2 === 0 ? "paid" : "pending",
      createdAt: new Date(now - (i % 5) * 86400000),
    })),
  );

  // groupBy
  const byStatus = await db.groupBy(
    "orders",
    {},
    {
      groupBy: "$status",
      accumulate: { count: { $sum: 1 }, revenue: { $sum: "$total" } },
      sort: { revenue: -1 },
    },
  );
  console.log("orders by status:", JSON.stringify(byStatus));

  // dateRangeAnalysis
  const byDay = await db.dateRangeAnalysis(
    "orders",
    {},
    {
      dateField: "createdAt",
      startDate: new Date(now - 6 * 86400000),
      endDate: new Date(now),
      granularity: "day",
    },
  );
  console.log("orders per day:", JSON.stringify(byDay));

  // Low-level aggregate with the typed stage builder.
  const top = await db.aggregate("orders", (stages) => [
    stages.match({ status: "paid" }),
    stages.group({ _id: "$userId", total: { $sum: "$total" } }),
    stages.sort({ total: -1 }),
    stages.limit(3),
    // Realistic $lookup: the group's `_id` IS the userId (grouped docs dropped
    // the original `userId` field), so join users on `_id`.
    stages.lookup({ from: "users", localField: "_id", as: "customer", foreignField: "_id" }),
  ]);
  const topDocs = await top.toArray();
  console.log("top paid customers:", JSON.stringify(topDocs));

  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
