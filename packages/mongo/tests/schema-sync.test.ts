/**
 * `syncIndexes` — reconcile a collection's real indexes with the declared set.
 *
 * `createSchema` installs indexes at creation time, but indexes can drift out
 * of band (manual drops/adds, other tooling). `syncIndexes` recreates missing
 * declared indexes and drops undeclared ones (`_id_` is always kept).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  closeService,
  makeEnterpriseService,
  maybeDescribe,
  probe as mongoProbe,
} from "./helpers.ts";

const maybe = maybeDescribe(await mongoProbe());

maybe("syncIndexes", () => {
  let ctx: Awaited<ReturnType<typeof makeEnterpriseService>>;

  beforeAll(async () => {
    // `perf: false` keeps reads deterministic (no cache masking).
    ctx = await makeEnterpriseService("ninox_syncindexes", { perf: false });
  });

  afterAll(async () => {
    if (ctx) await closeService(ctx);
  });

  test("leaves a collection whose indexes already match untouched", async () => {
    const { db } = ctx;
    const before = await db.client.collection("products").indexes();
    const res = await db.syncIndexes("products");
    expect(res.created).toEqual([]);
    expect(res.dropped).toEqual([]);
    expect((await db.client.collection("products").indexes()).length).toBe(before.length);
  });

  test("recreates a dropped declared index", async () => {
    const { db } = ctx;
    // products declares a unique index on sku (auto-named `sku_1`).
    await db.client.collection("products").dropIndex("sku_1");
    const res = await db.syncIndexes("products");
    expect(res.created).toContain("sku_1");
    const indexes = await db.client.collection("products").indexes();
    expect(indexes.some((i) => i.name === "sku_1")).toBe(true);
  });

  test("drops an undeclared index", async () => {
    const { db } = ctx;
    await db.client.collection("products").createIndex({ name: 1 }); // not declared
    const res = await db.syncIndexes("products");
    expect(res.dropped).toContain("name_1");
    const indexes = await db.client.collection("products").indexes();
    expect(indexes.some((i) => i.name === "name_1")).toBe(false);
    // The declared index survives.
    expect(indexes.some((i) => i.name === "sku_1")).toBe(true);
  });
});
