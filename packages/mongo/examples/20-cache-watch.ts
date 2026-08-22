/**
 * cacheWatch — optional change-stream invalidation of the shared QueryCache.
 *
 *   bun run examples/20-cache-watch.ts
 *
 * The ORM's query cache is write-through only: ORM writes invalidate it, but
 * EXTERNAL writes (the raw `client` escape hatch, other processes, direct DB
 * writes) do not — so cached reads can go stale under multi-writer deployments.
 * `cacheWatch: true` opens one `$changeStream` watcher per collection so
 * external writes invalidate the cache too.
 *
 * Requires a replica set / mongos. On a standalone server the watchers are
 * rejected and `cacheWatch` logs a warning once, then stays write-through only
 * (this example prints which mode it is in).
 */
import { createConsoleLogger, probeMongoCapabilities } from "../src/index.ts";
import { close, connect } from "./shared/setup.ts";

const DB = "ninox_examples_20_cache_watch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  // Surface the cacheWatch warning on standalone (silent logger otherwise).
  const ctx = await connect(DB, { cacheWatch: true, logger: createConsoleLogger() });
  const { db } = ctx;

  const caps = await probeMongoCapabilities(db.client);
  const replica = caps.transactionsSupported;
  console.log(
    "server is",
    replica
      ? "a replica set → cacheWatch change streams are active"
      : "standalone → cacheWatch stays write-through only (see the warning above)",
  );

  // Seed a product and warm the cache.
  await db.insertOne("products", { sku: "W-1", name: "Watch", price: 10 });
  const before = await db.getOne("products", { sku: "W-1" });
  await db.getOne("products", { sku: "W-1" }); // warm → cache hit
  console.log("cached price:", before?.price);

  // External write via the RAW driver — bypasses the ORM, so the only thing
  // that can invalidate the cache is the change stream (replica) or nothing
  // (standalone).
  await db.client.collection("products").updateOne({ sku: "W-1" }, { $set: { price: 99 } });

  // Change-stream delivery is async on replica sets — poll for freshness.
  const target = 99;
  const deadline = Date.now() + 4000;
  let current = before;
  while (Date.now() < deadline) {
    current = await db.getOne("products", { sku: "W-1" });
    if (current && current.price === target) break;
    await sleep(100);
  }
  console.log(
    replica && current?.price === target
      ? "replica: external write invalidated the cache → fresh price 99"
      : `standalone: cache stayed stale (price ${current?.price}) — for freshness set cache: { ttlMs } or use the HotCache`,
  );

  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
