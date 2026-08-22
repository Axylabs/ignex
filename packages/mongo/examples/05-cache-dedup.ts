/**
 * Query cache + in-flight dedup — ON by default. This example measures driver
 * round-trips via `serverStatus.opcounters.query` to show:
 *   - a cache hit performs ZERO driver calls
 *   - N identical concurrent reads coalesce into ONE driver call
 *   - how to opt out (`cache: null`, `dedupeReads: false`, per-op flags)
 *
 *   bun run examples/05-cache-dedup.ts
 */
import { close, connect, MONGO_URL } from "./shared/setup.ts";

const DB = "ninox_examples_05_cache_dedup";

const serverQueryCount = async (db: {
  client: {
    admin(): { command(c: Record<string, unknown>): Promise<{ opcounters?: { query?: number } }> };
  };
}) => {
  const status = await db.client.admin().command({ serverStatus: 1 });
  return status.opcounters?.query ?? 0;
};

const run = async () => {
  const ctx = await connect(DB);
  const { db } = ctx;

  await db.insertOne("users", { email: "ada@example.com", role: "admin", createdAt: new Date() });

  // 1) Cache hit = 0 driver calls. First read populates the cache; second is served from it.
  const q0 = await serverQueryCount(db);
  await db.findMany("users", { role: "admin" }); // cold → driver
  const q1 = await serverQueryCount(db);
  await db.findMany("users", { role: "admin" }); // warm → cache hit
  const q2 = await serverQueryCount(db);
  console.log("cold read queries:", q1 - q0, "| cache-hit queries:", q2 - q1);

  // 2) In-flight dedup: 50 identical concurrent reads → 1 driver call.
  const q3 = await serverQueryCount(db);
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: 50 }, () => db.countDocuments("users", { role: "admin" })),
  );
  const elapsed = performance.now() - t0;
  const q4 = await serverQueryCount(db);
  console.log(
    "50 concurrent identical reads:",
    q4 - q3,
    "driver queries in",
    elapsed.toFixed(1),
    "ms",
  );

  // 3) Opt-outs. Per-op: `{ cache: false }` / `.cache(false)`. Service-wide:
  //    createMongoService(cfg, { cache: null, dedupeReads: false, perf: false })
  const uncached = await db.getOne("users", { email: "ada@example.com" }, { cache: false });
  console.log(
    "uncached read:",
    uncached?.email,
    "(url:",
    MONGO_URL === process.env.MONGO_URL ? "env" : "default)",
  );

  await close(ctx);
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
