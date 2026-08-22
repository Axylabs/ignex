/**
 * Repository layer — `createRepository(manager, collection)` binds a manager +
 * collection into a domain-typed wrapper (`getById`, `create`, `update`,
 * `updateVersioned`, `page`, `pageCursor`, `populate`, …). No change tracking:
 * load → mutate → persist is explicit, matching the core op semantics.
 *
 *   bun run examples/14-repository.ts
 */
import { belongsTo, createRepository } from "../src/index.ts";
import { close, connect } from "./shared/setup.ts";

const DB = "ninox_examples_14_repository";

const run = async () => {
  const ctx = await connect(DB);
  const { db } = ctx;

  const users = createRepository(db, "users");
  const orders = createRepository(db, "orders");

  const { insertedId } = await users.create({
    email: "repo@example.com",
    role: "user",
    createdAt: new Date(),
  });
  const found = await users.getById(insertedId);
  console.log("created + fetched:", found?.email);

  const res = await orders.createMany([
    { userId: insertedId, total: 10, status: "paid", createdAt: new Date() },
    { userId: insertedId, total: 20, status: "pending", createdAt: new Date() },
  ]);
  const firstOrderId = Object.values(res.insertedIds)[0]!;

  await orders.update(firstOrderId, { $set: { status: "shipped" } });
  const page = await orders.page({ userId: insertedId }, { page: 1, limit: 10 });
  console.log(`order page: ${page.data.length} shown / ${page.totalCount} total`);

  const list = await orders.findMany({ userId: insertedId });
  const joined = await orders.populate(list, [
    belongsTo({ collection: "users", localField: "userId", as: "customer" }),
  ]);
  console.log("populated customer email:", joined[0]?.customer?.email);

  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
