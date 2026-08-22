/**
 * File-based migrations with an idempotency journal.
 *
 *   bun run examples/08-migrations.ts
 *
 * Migrations live in `examples/fixtures/migrations/` (numeric-prefixed) and run
 * against the shared `products` collection.
 */
import { createMongoMigrationRunner } from "../src/index.ts";
import { close, connect } from "./shared/setup.ts";

const DB = "ninox_examples_08_migrations";

const run = async () => {
  const ctx = await connect(DB);
  const { db } = ctx;

  const runner = createMongoMigrationRunner(ctx.toolkit.service, {
    migrationDir: `${import.meta.dir}/fixtures/migrations`,
  });

  await runner.up();
  const migrated = await db.findMany("products", { sku: "MIGRATED" });
  console.log(
    "after up:",
    migrated.map((p) => p.name),
  );

  await runner.down("001_seed_products");
  const afterDown = await db.findMany("products", { sku: "MIGRATED" });
  console.log("after down(001):", afterDown.length, "migrated products left");

  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
