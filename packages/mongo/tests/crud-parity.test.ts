import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  closeService,
  type EnterpriseServiceContext,
  makeEnterpriseService,
  maybeDescribe,
  probe,
} from "./helpers.ts";

const available = await probe();
const maybe = maybeDescribe(available);

maybe("CRUD parity + bulkWrite + collation (real MongoDB)", () => {
  let ctx!: EnterpriseServiceContext;
  let db!: EnterpriseServiceContext["db"];
  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_crud_parity_test");
    db = ctx.db;
  });
  afterAll(() => closeService(ctx));

  const makeReview = (title: string) => ({
    productId: ctx.seed.productIds[0]!,
    customerId: ctx.seed.customerIds[0]!,
    rating: 5,
    title,
    body: "Body text for the review.",
    verified: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  test("distinct returns typed field values (with and without filter)", async () => {
    const statuses = await db.distinct("orders", "status");
    expect(statuses.length).toBeGreaterThan(0);
    for (const s of statuses) expect(["pending", "paid", "shipped", "cancelled"]).toContain(s);

    const paid = await db.distinct("orders", "status", { status: "paid" });
    expect(paid).toEqual(["paid"]);
  });

  test("findOneAndDelete returns the deleted doc and removes it", async () => {
    const { insertedId } = await db.insertOne("reviews", makeReview("Delete Me"));
    const doc = await db.findOneAndDelete("reviews", { _id: insertedId });
    expect(doc?._id).toEqual(insertedId);
    expect(await db.getOne("reviews", { _id: insertedId })).toBeNull();
  });

  test("replaceOne fully replaces a document", async () => {
    const { insertedId } = await db.insertOne("reviews", makeReview("Original"));
    const res = await db.replaceOne(
      "reviews",
      { _id: insertedId },
      {
        productId: ctx.seed.productIds[1]!,
        customerId: ctx.seed.customerIds[1]!,
        rating: 3,
        title: "Replaced",
        body: "A brand new body.",
        verified: false,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    );
    expect(res.modifiedCount).toBe(1);
    const doc = await db.getOne("reviews", { _id: insertedId });
    expect(doc?.title).toBe("Replaced");
    expect(doc?.rating).toBe(3);
    expect(doc?.verified).toBe(false);
  });

  test("estimatedDocumentCount returns a positive count", async () => {
    const n = await db.estimatedDocumentCount("orders");
    expect(n).toBeGreaterThan(0);
  });

  test("bulkWrite executes mixed operations and invalidates the cache", async () => {
    // Prime the cache with a read, then write through bulkWrite, then re-read.
    const before = await db.findMany("reviews", { title: "Bulk 1" });
    expect(before.length).toBe(0);

    const res = await db.bulkWrite("reviews", [
      { insertOne: { document: makeReview("Bulk 1") } },
      { insertOne: { document: makeReview("Bulk 2") } },
      { updateMany: { filter: { title: "Bulk 1" }, update: { $set: { verified: false } } } },
      { deleteMany: { filter: { title: "Bulk 2" } } },
    ]);
    expect(res.insertedCount).toBe(2);
    expect(res.modifiedCount).toBe(1);
    expect(res.deletedCount).toBe(1);

    // Cache was invalidated: a fresh read reflects the bulk writes.
    const after = await db.findMany("reviews", { title: "Bulk 1" });
    expect(after.length).toBe(1);
    expect(after[0]?.verified).toBe(false);
  });

  test("collation enables case-insensitive matching", async () => {
    await db.insertOne("reviews", makeReview("Alpha"));
    await db.insertOne("reviews", makeReview("alpha"));
    const ci = await db.findMany(
      "reviews",
      { title: "alpha" },
      {
        collation: { locale: "en", strength: 2 },
      },
    );
    expect(ci.filter((r) => r.title === "Alpha" || r.title === "alpha").length).toBe(2);
  });
});
