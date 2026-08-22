/**
 * Performance by default — a mini benchmark of the default-fast path.
 *
 * Creates the SAME service twice, once with the default (cache + dedup ON) and
 * once fully opted out, then counts driver queries under identical work:
 *   - repeated identical reads (default: 1 driver call, then cache hits)
 *   - 50 concurrent identical reads (default: 1 driver call)
 *
 *   bun run examples/09-perf-defaults.ts
 */
import { createMongoToolkit } from "../src/index.ts";
import { collections } from "./shared/schema.ts";
import { MONGO_URL } from "./shared/setup.ts";

const DB = "ninox_examples_09_perf_defaults";

const serverQueryCount = async (db: {
  client: {
    admin(): { command(c: Record<string, unknown>): Promise<{ opcounters?: { query?: number } }> };
  };
}) => {
  const status = await db.client.admin().command({ serverStatus: 1 });
  return status.opcounters?.query ?? 0;
};

const makeToolkit = (opts: { cache?: null; dedupeReads?: boolean; perf?: boolean } = {}) =>
  createMongoToolkit(
    { primary: { name: DB, dbUrl: MONGO_URL, collections } },
    { logger: { debug() {}, info() {}, warn() {}, error() {} }, ...opts },
  );

const run = async () => {
  // Default: cache + dedup ON.
  const onToolkit = makeToolkit();
  await onToolkit.service.makeConnections();
  const on = onToolkit.service.db.primaryClient;

  // Opted out.
  const offToolkit = makeToolkit({ cache: null, dedupeReads: false });
  await offToolkit.service.makeConnections();
  const off = offToolkit.service.db.primaryClient;

  await on.insertMany(
    "users",
    Array.from({ length: 20 }, (_, i) => ({
      email: `u${i}@example.com`,
      role: "user",
      createdAt: new Date(),
    })),
  );

  // Repeated identical reads: default caches after the first call.
  const readTwice = async (db: typeof on) => {
    await db.findMany("users", { role: "user" });
    await db.findMany("users", { role: "user" });
  };
  const q0 = await serverQueryCount(off);
  await readTwice(off);
  const q1 = await serverQueryCount(off);
  const q2 = await serverQueryCount(on);
  await readTwice(on);
  const q3 = await serverQueryCount(on);
  console.log("two identical reads → driver queries (off):", q1 - q0, "| (default on):", q3 - q2);

  // 50 concurrent identical reads: default coalesces to one driver call.
  const fire = (db: typeof on, n: number) =>
    Promise.all(Array.from({ length: n }, () => db.countDocuments("users", { role: "user" })));
  const q4 = await serverQueryCount(off);
  await fire(off, 50);
  const q5 = await serverQueryCount(off);
  const q6 = await serverQueryCount(on);
  await fire(on, 50);
  const q7 = await serverQueryCount(on);
  console.log("50 concurrent reads → driver queries (off):", q5 - q4, "| (default on):", q7 - q6);

  await new Promise((r) => setTimeout(r, 50));
  await onToolkit.service.closeConnections();
  await offToolkit.service.closeConnections();
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
