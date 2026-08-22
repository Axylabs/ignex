/**
 * Optional change-stream cache invalidation (`MongoServiceConfig.cacheWatch`).
 *
 * The shared QueryCache is write-through only — external writes (the raw
 * `client` escape hatch, other processes, direct DB writes) don't invalidate
 * it. `cacheWatch: true` opens `$changeStream` watchers so those external
 * writes DO invalidate. On standalone servers the streams are rejected → a
 * one-time warning and invalidation disables (cache stays write-through only);
 * the replica test proves external-write invalidation (skipped on standalone).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sleep } from "../src/utils/timeout.ts";
import {
  captureLogger,
  closeService,
  makeEnterpriseService,
  maybeDescribe,
  noopLogger,
  probe,
  probeReplica,
} from "./helpers.ts";

const replica = await probeReplica();
const maybeReplica = maybeDescribe(replica);
// Standalone suites run only when Mongo is REACHABLE but not a replica set —
// an unreachable/differently-credentialed local Mongo must skip both suites.
const maybeStandalone = maybeDescribe(!replica && (await probe()));

maybeStandalone("cacheWatch — standalone fallback", () => {
  let ctx: Awaited<ReturnType<typeof makeEnterpriseService>>;
  let logger: ReturnType<typeof captureLogger>;

  beforeAll(async () => {
    logger = captureLogger();
    ctx = await makeEnterpriseService("ninox_cachewatch_standalone", {
      cacheWatch: true,
      logger: logger.logger,
    });
  });

  afterAll(async () => {
    if (ctx) await closeService(ctx);
  });

  test("change streams unsupported on standalone → warns once; cache stays write-through", async () => {
    // Give the failing watchers a moment to surface their verdict.
    await sleep(100);
    expect(logger.warns.some((w) => w.msg?.includes("cacheWatch"))).toBe(true);

    // The ORM cache is unaffected: identical reads are served from the cache.
    const sku = ctx.seed.productSkus[0];
    const first = await ctx.db.getOne("products", { sku });
    const second = await ctx.db.getOne("products", { sku });
    expect(second).toEqual(first);
  });
});

maybeReplica("cacheWatch — replica external-write invalidation", () => {
  let ctx: Awaited<ReturnType<typeof makeEnterpriseService>>;

  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_cachewatch_replica", {
      cacheWatch: true,
      logger: noopLogger,
    });
  });

  afterAll(async () => {
    if (ctx) await closeService(ctx);
  });

  test("an external write invalidates the cached read", async () => {
    const sku = ctx.seed.productSkus[0];
    const before = await ctx.db.getOne("products", { sku });
    expect(before).not.toBeNull();
    // Warm the cache (second identical read is a hit — no extra driver call).
    await ctx.db.getOne("products", { sku });

    // Mutate via the RAW driver — bypasses the ORM, so there is no write-through
    // invalidation. The change stream must drop the cached entry.
    await ctx.db.client
      .collection("products")
      .updateOne({ sku }, { $set: { price: before!.price + 1000 } });

    // Change-stream delivery is async — poll until the read is fresh.
    const target = before!.price + 1000;
    const deadline = Date.now() + 5000;
    let current = before;
    while (Date.now() < deadline) {
      current = await ctx.db.getOne("products", { sku });
      if (current !== null && current.price === target) break;
      await sleep(50);
    }
    expect(current?.price).toBe(target);
  });
});
