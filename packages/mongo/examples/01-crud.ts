/**
 * Basic CRUD + optimistic locking.
 *
 *   bun run examples/01-crud.ts
 */
import { close, connect } from "./shared/setup.ts";

const DB = "ninox_examples_01_crud";

const run = async () => {
  const ctx = await connect(DB);
  const { db } = ctx;

  // insertOne / insertMany — `_id` is optional at insert time.
  const res = await db.insertOne("users", {
    email: "ada@example.com",
    role: "admin",
    createdAt: new Date(),
  });

  const userId = res.insertedId;

  await db.insertMany("orders", [
    { userId, total: 199.99, status: "paid", createdAt: new Date() },
    { userId, total: 59.5, status: "pending", createdAt: new Date() },
  ]);

  // Reads (cached + deduped by default).
  const found = await db.getOne("users", { email: "ada@example.com" });
  const admin = await db.getOneOrFail("users", { role: "admin" });
  const paid = await db.findMany("orders", { status: "paid" });
  console.log("found:", found?.email, "| admin:", admin.email, "| paid orders:", paid.length);

  // Field projection on flat find queries — only the listed fields are transferred.
  const emails = await db.findMany("users", { role: "admin" }, { select: ["email"] });
  console.log("admin emails:", emails.map((u) => u.email).join(", "));

  // Update + optimistic locking (__v) — a stale write loses.
  await db.updateOne("users", { _id: userId }, { $set: { name: "Ada" } });
  const v1 = await db.updateWithVersion(
    "users",
    { _id: userId },
    { $set: { email: "ada.l@example.com" } },
  );
  const v2 = await db.updateWithVersion(
    "users",
    { _id: userId },
    { $set: { email: "ada@example.com" } },
  );
  console.log("optimistic updates (v1/v2 both expected):", v1.ok, v2.ok);

  console.log("order count:", await db.countDocuments("orders", {}));
  await db.deleteMany("orders", { status: "pending" });
  console.log("orders after delete:", await db.countDocuments("orders", {}));

  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
