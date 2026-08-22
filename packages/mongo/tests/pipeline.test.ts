/**
 * Runtime tests for the type-safe aggregation pipeline (`db.pipeline()`) and
 * the typed callback `db.aggregate()` stages. Guarded by a local MongoDB —
 * skipped when no Mongo is reachable (mirrors `tests/integration.test.ts`).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ObjectId } from "mongodb";
import { BadRequest } from "../src/errors/index.ts";
import { type InferDoc, s } from "../src/schema/index.ts";
import { createMongoService } from "../src/service/index.ts";
import { MONGO_URL, maybeDescribe, noopLogger, probe } from "./helpers.ts";

const DB_NAME = "ninox_orm_pipeline_test";

const userSchema = s.object(
  {
    _id: s.objectId(),
    email: s.string(),
    name: s.string().optional(),
    role: s.enum(["admin", "user"] as const),
    createdAt: s.date(),
  },
  { name: "users" },
);
type User = InferDoc<typeof userSchema>;

const orderSchema = s.object(
  {
    _id: s.objectId(),
    userId: s.objectId(),
    total: s.number({ minimum: 0 }),
    status: s.enum(["pending", "paid", "shipped"] as const),
    createdAt: s.date(),
  },
  { name: "orders" },
);
type Order = InferDoc<typeof orderSchema>;

const available = await probe();
const maybe = maybeDescribe(available);

maybe("typed aggregation pipeline (real MongoDB)", () => {
  const service = createMongoService(
    {
      primary: {
        name: DB_NAME,
        dbUrl: MONGO_URL,
        collections: { users: userSchema, orders: orderSchema },
      },
    },
    { logger: noopLogger },
  );

  let userId!: ObjectId;
  const now = Date.now();

  beforeAll(async () => {
    await service.makeConnections();
    const db = service.db.primaryClient;
    await db.client.dropCollection("users").catch(() => {});
    await db.client.dropCollection("orders").catch(() => {});
    await db.createSchema("users");
    await db.createSchema("orders");
    const res = await db.insertOne("users", {
      email: "ada@example.com",
      role: "admin",
      createdAt: new Date(now),
    });
    userId = res.insertedId;
    await db.insertMany("orders", [
      { userId, total: 100, status: "paid", createdAt: new Date(now) },
      { userId, total: 50, status: "pending", createdAt: new Date(now - 86400000) },
      { userId, total: 25, status: "shipped", createdAt: new Date(now - 2 * 86400000) },
    ]);
  });

  afterAll(async () => {
    await service.closeConnections();
  });

  test("rejects non-finite limit/skip/sample before hitting the DB", async () => {
    const db = service.db.primaryClient;
    expect(() => db.pipeline("orders").limit(NaN)).toThrow(BadRequest);
    expect(() => db.pipeline("orders").skip(Infinity)).toThrow(BadRequest);
    expect(() => db.pipeline("orders").sample(-1)).toThrow(BadRequest);
  });

  test("chained pipeline: match → group → sort → limit (inferred result)", async () => {
    const db = service.db.primaryClient;
    const rows = await db
      .pipeline("orders")
      .match({ status: "paid" })
      .group({ _id: "$status", revenue: { $sum: "$total" }, count: { $sum: 1 } })
      .sort({ revenue: -1 })
      .limit(5)
      .toArray();
    expect(rows).toEqual([{ _id: "paid", revenue: 100, count: 1 }]);
  });

  test("project recomputes the output shape", async () => {
    const db = service.db.primaryClient;
    const rows = await db.pipeline("users").project({ email: 1, name: 1 }).toArray();
    expect(rows[0]).toHaveProperty("email");
    expect(rows[0]).not.toHaveProperty("role");
  });

  test("$lookup sub-pipeline joins and shapes the foreign doc", async () => {
    const db = service.db.primaryClient;
    const rows = await db
      .pipeline("users")
      .lookup({
        from: "orders",
        localField: "_id",
        foreignField: "userId",
        as: "orders",
        pipeline: (o) => o.match({ total: { $gt: 50 } }).project({ total: 1 }),
      })
      .toArray();
    const user = rows[0];
    expect(user?.orders).toHaveLength(1);
    expect(user?.orders[0]?.total).toBe(100);
    // `status` was projected away inside the sub-pipeline
    expect(user?.orders[0]).not.toHaveProperty("status");
  });

  test("$facet runs typed branches", async () => {
    const db = service.db.primaryClient;
    const rows = await db
      .pipeline("orders")
      .facet({
        byStatus: (s) => s.group({ _id: "$status", count: { $sum: 1 } }),
        top: (s) => s.sort({ total: -1 }).limit(2),
      })
      .toArray();
    const row = rows[0];
    expect(row?.byStatus).toHaveLength(3);
    expect(row?.byStatus).toContainEqual({ _id: "paid", count: 1 });
    expect(row?.byStatus).toContainEqual({ _id: "pending", count: 1 });
    expect(row?.top).toHaveLength(2);
    expect(row?.top[0]?.total).toBe(100);
  });

  test("$unwind turns a $lookup array into a scalar", async () => {
    const db = service.db.primaryClient;
    const rows = await db
      .pipeline("users")
      .lookup({ from: "orders", localField: "_id", foreignField: "userId", as: "orders" })
      .unwind("$orders")
      .toArray();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.orders.total).toBeGreaterThan(0);
  });

  test("addFields + count", async () => {
    const db = service.db.primaryClient;
    const withTax = await db
      .pipeline("orders")
      .addFields({ totalWithTax: { $multiply: ["$total", 1.1] } })
      .toArray();
    expect(withTax[0]?.totalWithTax).toBeCloseTo(withTax[0]!.total * 1.1, 5);
    const counts = await db.pipeline("orders").count("n").toArray();
    expect(counts).toEqual([{ n: 3 }]);
  });

  test("first() and cursor() terminals", async () => {
    const db = service.db.primaryClient;
    const one = await db.pipeline("orders").sort({ total: -1 }).first();
    expect(one?.total).toBe(100);
    const cursor = db.pipeline("orders").sort({ total: -1 }).cursor();
    const first = await cursor.tryNext();
    expect(first?.total).toBe(100);
    await cursor.close();
  });

  test("callback aggregate() stages are typed and run", async () => {
    const db = service.db.primaryClient;
    const cursor = await db.aggregate("orders", (stages) => [
      stages.match({ status: "paid" }),
      stages.group({ _id: "$status", revenue: { $sum: "$total" } }),
      stages.sort({ revenue: -1 }),
      stages.limit(3),
    ]);
    const rows = await cursor.toArray();
    expect(rows).toEqual([{ _id: "paid", revenue: 100 }]);
  });

  test("callback lookup() with a typed sub-pipeline", async () => {
    const db = service.db.primaryClient;
    const cursor = await db.aggregate("users", (stages) => [
      stages.lookup({
        from: "orders",
        localField: "_id",
        foreignField: "userId",
        as: "orders",
        pipeline: (o) => o.match({ total: { $gt: 50 } }).project({ total: 1 }),
      }),
    ]);
    const rows = await cursor.toArray();
    expect(rows[0]?.orders).toHaveLength(1);
  });
});
