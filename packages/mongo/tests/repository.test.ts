import { afterAll, beforeAll, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { belongsTo } from "../src/relation/relation.ts";
import { createRepository } from "../src/repository/repository.ts";
import {
  closeService,
  type EnterpriseServiceContext,
  makeEnterpriseService,
  maybeDescribe,
  probe,
} from "./helpers.ts";

const available = await probe();
const maybe = maybeDescribe(available);

maybe("repository layer (real MongoDB)", () => {
  let ctx!: EnterpriseServiceContext;
  let db!: EnterpriseServiceContext["db"];
  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_repo_test");
    db = ctx.db;
  });
  afterAll(() => closeService(ctx));

  test("getById / getByIds / findOne / findMany / count / exists / distinct", async () => {
    const reviews = createRepository(db, "reviews");
    const id = ctx.seed.reviewIds[0]!;
    const doc = await reviews.getById(id);
    expect(doc?._id).toEqual(id);

    const byIds = await reviews.getByIds([id, ctx.seed.reviewIds[1]!]);
    expect(byIds.length).toBe(2);

    expect(await reviews.exists({ _id: id })).toBe(true);
    expect(await reviews.exists({ _id: new ObjectId() })).toBe(false);
    expect(await reviews.count({})).toBeGreaterThan(0);

    const one = await reviews.findOne({ _id: id });
    expect(one?._id).toEqual(id);
    const many = await reviews.findMany({ verified: true });
    expect(many.length).toBeGreaterThan(0);

    const statuses = createRepository(db, "orders").distinct;
    expect(typeof statuses).toBe("function");
  });

  test("create / update / updateVersioned / deleteById", async () => {
    const reviews = createRepository(db, "reviews");
    const { insertedId } = await reviews.create({
      productId: ctx.seed.productIds[0]!,
      customerId: ctx.seed.customerIds[0]!,
      rating: 4,
      title: "Repo create",
      body: "Body from repository create.",
      verified: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const created = await reviews.getById(insertedId);
    expect(created?.title).toBe("Repo create");

    await reviews.update(insertedId, { $set: { rating: 2 } });
    expect((await reviews.getById(insertedId))?.rating).toBe(2);

    const vres = await reviews.updateVersioned(insertedId, { $set: { title: "V2" } });
    expect(vres.ok).toBe(true);

    await reviews.deleteById(insertedId);
    expect(await reviews.getById(insertedId)).toBeNull();
  });

  test("page / pageCursor / pipeline / populate delegate to the manager", async () => {
    const orderRepo = createRepository(db, "orders");

    const page = await orderRepo.page({}, { page: 1, limit: 5 });
    expect(page.data.length).toBeGreaterThan(0);

    const cur = await orderRepo.pageCursor({}, { sort: { placedAt: -1, _id: 1 }, limit: 3 });
    expect(cur.data.length).toBeGreaterThan(0);

    const statuses = await orderRepo.distinct("status");
    expect(statuses.length).toBeGreaterThan(0);

    const top = await orderRepo.pipeline().sort({ placedAt: -1 }).limit(2).toArray();
    expect(top.length).toBe(2);

    const sample = await db.findMany("orders", { _id: { $in: ctx.seed.orderIds.slice(0, 3) } });
    const joined = await orderRepo.populate(sample, [
      belongsTo({ collection: "customers", localField: "customerId", as: "customer" }),
    ]);
    expect(joined[0]?.customer).toBeDefined();
  });
});
