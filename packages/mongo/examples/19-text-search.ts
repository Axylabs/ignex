/**
 * Search + joins — `textSearch` and `lookupJoin`.
 *
 *   bun run examples/19-text-search.ts
 *
 * `textSearch` supports `$text` mode (needs a text index on the search fields,
 * created below) or `$regex` mode (`useRegex: true`, no index needed).
 * `lookupJoin` is a single-hop `$lookup` with optional `$unwind`.
 */

import type { Order, User } from "./shared/schema.ts";
import { close, connect } from "./shared/setup.ts";

const DB = "ninox_examples_19_text_search";

const run = async () => {
  const ctx = await connect(DB);
  const { db } = ctx;

  const { insertedId: userId } = await db.insertOne("users", {
    email: "search@example.com",
    role: "user",
    createdAt: new Date(),
  });

  await db.insertMany("products", [
    { sku: "S001", name: "Alpha Widget", price: 9.99 },
    { sku: "S002", name: "Beta Gadget", price: 19.99 },
    { sku: "S003", name: "Alpha Gadget Pro", price: 49.99 },
    { sku: "S004", name: "Gamma Widget Mini", price: 4.99 },
  ]);
  await db.insertMany("orders", [
    { userId, total: 9.99, status: "paid", createdAt: new Date() },
    { userId, total: 49.99, status: "paid", createdAt: new Date() },
  ]);

  // $text search — requires a text index on the searched fields.
  await db.client.collection("products").createIndex({ name: "text" });
  const hits = await db.textSearch(
    "products",
    {},
    { searchFields: ["name"], searchTerm: "gadget", sortByScore: true },
    { page: 1, limit: 10 },
  );
  console.log(
    '$text search "gadget":',
    hits.data.map((p) => p.name),
  );

  // $regex search — no index required, per-field $or matching.
  const regex = await db.textSearch(
    "products",
    {},
    { searchFields: ["name"], searchTerm: "widget", useRegex: true, fuzzy: true },
    { page: 1, limit: 10 },
  );
  console.log(
    '$regex search "widget":',
    regex.data.map((p) => p.name),
  );

  // lookupJoin — orders → users via userId → _id, unwound into `customer`.
  const joined = await db.lookupJoin<"orders", Order & { customer?: User }>("orders", {}, [
    {
      fromCollection: "users",
      localField: "userId",
      foreignField: "_id",
      as: "customer",
      unwindSingle: true,
    },
  ]);
  console.log(
    "lookupJoin orders→users:",
    joined.map((o) => `${o.total} by ${o.customer?.email ?? "n/a"}`),
  );

  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
