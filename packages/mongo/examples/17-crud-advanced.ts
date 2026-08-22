/**
 * Advanced CRUD — the ops beyond the basics.
 *
 *   bun run examples/17-crud-advanced.ts
 *
 * Covers `bulkWrite`, `bulkUpsert`, `distinct`, `estimatedDocumentCount`,
 * `replaceOne`, `findOneAndDelete`, and `updateMany`.
 */
import { close, connect } from "./shared/setup.ts";

const DB = "ninox_examples_17_crud_advanced";

const run = async () => {
  const ctx = await connect(DB);
  const { db } = ctx;

  const { insertedId } = await db.insertOne("users", {
    email: "advanced@example.com",
    role: "admin",
    createdAt: new Date(),
  });

  // bulkUpsert — many updateOne-style upserts in one write.
  await db.bulkUpsert("products", [
    { filter: { sku: "A001" }, update: { $set: { name: "Alpha", price: 1.5 } } },
    { filter: { sku: "A002" }, update: { $set: { name: "Beta", price: 2.5 } } },
    { filter: { sku: "A003" }, update: { $set: { name: "Gamma", price: 3.5 } } },
  ]);
  console.log("bulkUpsert: 3 products ensured");

  // bulkWrite — arbitrary driver bulk operations (mix insert/update/delete).
  await db.bulkWrite("products", [
    { insertOne: { document: { sku: "B001", name: "Delta", price: 4.5 } } },
    { updateOne: { filter: { sku: "A001" }, update: { $set: { price: 1.75 } } } },
    { deleteOne: { filter: { sku: "A003" } } },
  ]);
  console.log("bulkWrite: mixed operations applied");

  // distinct — schema-typed field values.
  const roles = await db.distinct("users", "role");
  console.log("distinct roles:", roles);

  // estimatedDocumentCount — fast metadata count (not filter-aware).
  const approx = await db.estimatedDocumentCount("products");
  console.log("estimatedDocumentCount(products):", approx);

  // updateMany — bulk patch.
  await db.insertMany("orders", [
    { userId: insertedId, total: 10, status: "pending", createdAt: new Date() },
    { userId: insertedId, total: 20, status: "pending", createdAt: new Date() },
  ]);
  const updated = await db.updateMany(
    "orders",
    { status: "pending" },
    { $set: { status: "paid" } },
  );
  console.log("updateMany modified:", updated.modifiedCount);

  // replaceOne — full replacement (not a partial update).
  await db.replaceOne(
    "users",
    { _id: insertedId },
    { _id: insertedId, email: "replaced@example.com", role: "user", createdAt: new Date() },
  );
  console.log(
    "replaceOne: email replaced →",
    (await db.getOne("users", { _id: insertedId }))?.email,
  );

  // findOneAndDelete — atomic delete returning the doc.
  const deleted = await db.findOneAndDelete("users", { _id: insertedId });
  console.log("findOneAndDelete returned email:", deleted?.email);

  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
