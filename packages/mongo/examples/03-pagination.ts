/**
 * `$facet` pagination — count + page data in ONE round trip.
 *
 *   bun run examples/03-pagination.ts
 */
import { close, connect } from "./shared/setup.ts";

const DB = "ninox_examples_03_pagination";

const run = async () => {
  const ctx = await connect(DB);
  const { db } = ctx;

  await db.insertOne("users", { email: "buyer@example.com", role: "user", createdAt: new Date() });
  const { insertedId: userId } = await db.insertOne("users", {
    email: "owner@example.com",
    role: "admin",
    createdAt: new Date(),
  });

  await db.insertMany(
    "orders",
    Array.from({ length: 25 }, (_, i) => ({
      userId,
      total: (i % 500) + 0.99,
      status: i % 2 === 0 ? "paid" : "pending",
      createdAt: new Date(),
    })),
  );

  const page = await db.paginateFlexible(
    "orders",
    { status: "paid" },
    { page: 1, limit: 5, sort: { total: -1 } },
  );
  console.log({
    page: page.currentPage,
    perPage: page.data.length,
    totalCount: page.totalCount,
    totalPages: page.totalPages,
    hasNextPage: page.hasNextPage,
    topTotal: page.data[0]?.total,
  });

  const page2 = await db.paginateFlexible("orders", {}, { page: 3, limit: 5 });
  console.log("page 3 of all orders:", page2.data.length, "docs,", page2.totalCount, "total");

  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
