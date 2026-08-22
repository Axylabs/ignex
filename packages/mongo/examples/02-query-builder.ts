/**
 * Fluent query builder — schema-typed filters, driver-pushed projections,
 * and per-query performance toggles.
 *
 *   bun run examples/02-query-builder.ts
 */
import { close, connect } from "./shared/setup.ts";

const DB = "ninox_examples_02_query_builder";

const run = async () => {
  const ctx = await connect(DB);
  const { db } = ctx;

  await db.insertMany("users", [
    { email: "ada@example.com", role: "admin", createdAt: new Date() },
    { email: "bob@example.com", role: "user", createdAt: new Date() },
    { email: "grace@example.com", role: "user", createdAt: new Date() },
  ]);

  // Projection is pushed to the driver (`select`), so only these fields transfer.
  const admins = await db
    .query("users")
    .where({ role: "admin" })
    .select(["_id", "email"])
    .limit(10)
    .many();
  console.log(
    "admins:",
    admins.map((u) => u.email),
  );

  // exists / count
  const hasAdmin = await db.query("users").where({ role: "admin" }).exists();
  const total = await db.query("users").count();
  console.log("hasAdmin:", hasAdmin, "| total users:", total);

  // OR-composition
  const either = await db
    .query("users")
    .or({ email: "ada@example.com" }, { email: "bob@example.com" })
    .limit(10)
    .many();
  console.log(
    "either:",
    either.map((u) => u.email),
  );

  // Query-builder reads go through the default cache + dedup pipeline. Use
  // `.cache(false)` / `.dedupe(false)` to force a fresh, uncached read.
  const fresh = await db.query("users").where({ role: "user" }).cache(false).dedupe(false).one();
  console.log("fresh (uncached) read:", fresh?.email);

  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
