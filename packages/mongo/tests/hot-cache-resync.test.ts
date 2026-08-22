/**
 * HotCache — end-to-end failure-semantics test: kill the change-stream
 * consumer and prove the cache RESYNCHRONIZES.
 *
 * Replica-only (change streams). The scenario:
 *   1. Register a watch-bound query (raw loader) + warm the cache.
 *   2. `drop()` the watched collection → the server emits an `invalidate`
 *      event that ends the stream — this is the "consumer killed" moment.
 *   3. Recreate the collection and seed a DIFFERENT dataset (no validator on
 *      the recreated collection, so raw docs are fine).
 *   4. The watcher reconnects with backoff and invalidates the collection on
 *      reopen (invalidate-on-reopen), so the next read re-fetches from Mongo.
 *   5. Poll until the cache converges to the NEW count and assert it equals the
 *      live DB — proving resync after the consumer died.
 *
 * This proves RECOVERY/RESYNC (the invalidate-on-reopen path), not the
 * stale-during-outage window itself — the drop delivers an `invalidate` event
 * that also clears the cache. Staleness during a consumer outage is documented
 * behavior (see README "Failure semantics"); here we pin the self-heal.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Db } from "mongodb";
import { createHotCache } from "../src/cache/hot-cache/index.ts";
import {
  captureLogger,
  closeService,
  makeEnterpriseService,
  maybeDescribe,
  probeReplica,
} from "./helpers.ts";

const maybeReplica = maybeDescribe(await probeReplica());
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

maybeReplica("HotCache — real Mongo: consumer outage resync (replica)", () => {
  let ctx: Awaited<ReturnType<typeof makeEnterpriseService>>;
  let db: Db;

  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_hotcache_resync", { cache: null });
    db = ctx.db.client;
  });

  afterAll(async () => {
    if (ctx) await closeService(ctx);
  });

  test("drops stale entries and resyncs after the change-stream consumer dies", async () => {
    const { logger, warns } = captureLogger();
    const hot = createHotCache({ probe: async () => true, logger });
    const q = hot.register("productCount", {
      watch: [{ db, collection: "products" }],
      loader: async () => db.collection("products").countDocuments(),
    });
    await hot.start();
    expect(hot.mode).toBe("replica");

    // 1) Warm the cache from the seeded dataset.
    const v1 = await q.get();
    expect(v1).toBeGreaterThan(0);
    const liveV1 = await db.collection("products").countDocuments();
    expect(v1).toBe(liveV1);

    // 2) Kill the consumer: dropping the collection ends the change stream.
    await db.collection("products").drop();

    // 3) Recreate + reseed a DIFFERENT dataset (count 2 ≠ v1). The recreated
    //    collection has no $jsonSchema validator, so plain docs are fine.
    await db.createCollection("products");
    await db.collection("products").insertMany([
      { sku: "R-1", name: "Resync One", price: 1 },
      { sku: "R-2", name: "Resync Two", price: 2 },
    ]);

    // 4) Poll until the cache reflects the reseeded state. The watcher's
    //    reconnect backoff can reach 5s (+ jitter), so allow a generous window.
    let current = v1;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && current !== 2) {
      current = await q.get();
      await sleepMs(100);
    }

    // 5) RESYNC: the cache converged to the new DB state.
    expect(current).toBe(2);
    expect(current).toBe(await db.collection("products").countDocuments());

    // 6) The invalidate-on-reopen also emits a warning when the watcher
    //    reconnects. The value can converge before the reconnect (the drop's
    //    `invalidate` event + reseed already cleared/refilled the cache), so
    //    poll for the warning separately.
    const warnDeadline = Date.now() + 10_000;
    while (Date.now() < warnDeadline && !warns.some((w) => (w.msg ?? "").includes("reconnected"))) {
      await sleepMs(100);
    }
    expect(warns.some((w) => (w.msg ?? "").includes("reconnected"))).toBe(true);

    await hot.stop();
  });
});
