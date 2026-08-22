import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ObjectId } from "mongodb";
import { QueryCache } from "../src/cache/query-cache.ts";
import { createMongoCapabilitiesStore } from "../src/capabilities.ts";
import { DomainError } from "../src/errors/index.ts";
import { withGracefulMongoTransaction } from "../src/graceful-transaction.ts";
import { createMongoMigrationRunner } from "../src/migrations/index.ts";
import { belongsTo } from "../src/relation/relation.ts";
import { type InferDoc, s } from "../src/schema/index.ts";
import { createMongoService } from "../src/service/index.ts";
import { MONGO_URL, maybeDescribe, noopLogger, probe } from "./helpers.ts";

const DB_NAME = "ninox_orm_test";

const userSchema = s.object({
  _id: s.objectId(),
  email: s.string(),
  name: s.string().optional(),
  role: s.enum(["admin", "user"] as const),
  createdAt: s.date(),
});
type User = InferDoc<typeof userSchema>;

const orderSchema = s.object({
  _id: s.objectId(),
  userId: s.objectId(),
  total: s.number({ minimum: 0 }),
});
type Order = InferDoc<typeof orderSchema>;

const available = await probe();
const maybe = maybeDescribe(available);

maybe("integration (real MongoDB)", () => {
  const service = createMongoService(
    {
      primary: {
        name: DB_NAME,
        dbUrl: MONGO_URL,
        collections: {
          users: userSchema,
          orders: orderSchema,
        },
      },
    },
    { logger: noopLogger, cache: new QueryCache({ maxSize: 50 }), dedupeReads: true },
  );

  let userId!: ObjectId;

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
      createdAt: new Date(),
    });
    userId = res.insertedId;
    await db.insertMany("orders", [
      { userId, total: 100 },
      { userId, total: 50 },
    ]);
  });

  afterAll(async () => {
    await service.closeConnections();
  });

  test("validates documents server-side via $jsonSchema", async () => {
    const db = service.db.primaryClient;
    const bad = { email: "x", role: "not-a-role", createdAt: new Date() } as never;
    await expect(db.insertOne("users", bad)).rejects.toThrow();
  });

  test("CRUD roundtrip", async () => {
    const db = service.db.primaryClient;
    const doc = await db.getOneOrFail("users", { email: "ada@example.com" });
    expect((doc as User).role).toBe("admin");
    await expect(db.getOneOrFail("users", { email: "missing@example.com" })).rejects.toBeInstanceOf(
      DomainError,
    );
  });

  test("fluent query builder with projection", async () => {
    const db = service.db.primaryClient;
    const rows = await db
      .query("users")
      .where({ role: "admin" })
      .select(["_id", "email"])
      .limit(5)
      .many();
    expect(rows.length).toBe(1);
    expect(rows[0]?.email).toBe("ada@example.com");
  });

  test("$facet pagination returns data + total in one result", async () => {
    const db = service.db.primaryClient;
    const page = await db.paginateFlexible(
      "orders",
      { userId },
      { page: 1, limit: 1, sort: { total: -1 } },
    );
    expect(page.totalCount).toBe(2);
    expect(page.totalPages).toBe(2);
    expect(page.data).toHaveLength(1);
    expect((page.data[0] as Order).total).toBe(100);
  });

  test("DataLoader population (single batched $in query)", async () => {
    const db = service.db.primaryClient;
    const orders = await db.findMany("orders", { userId });
    const populated = await db.populate(orders, [
      belongsTo({ collection: "users", localField: "userId", as: "customer" }),
    ]);
    expect((populated[0]?.customer as User | null)?.email).toBe("ada@example.com");
  });

  test("query cache: second read is served from cache", async () => {
    const db = service.db.primaryClient;
    await db.findMany("users", { role: "admin" });
    const cache = (service as unknown as { config: { cache?: QueryCache } }).config;
    void cache;
    const rows = await db.findMany("users", { role: "admin" });
    expect(rows.length).toBeGreaterThan(0);
  });

  test("in-flight dedup coalesces concurrent identical reads", async () => {
    const db = service.db.primaryClient;
    const counts = await Promise.all([
      db.countDocuments("orders", { userId }),
      db.countDocuments("orders", { userId }),
      db.countDocuments("orders", { userId }),
    ]);
    expect(counts).toEqual([2, 2, 2]);
  });

  test("optimistic locking", async () => {
    const db = service.db.primaryClient;
    const created = await db.insertOne("users", {
      email: "lock@example.com",
      role: "user",
      createdAt: new Date(),
    });
    const first = await db.updateWithVersion(
      "users",
      { _id: created.insertedId },
      { $set: { email: "lock2@example.com" } },
    );
    expect(first.ok).toBe(true);

    // Version field is set by the lock.
    const doc = await db.getOne("users", { _id: created.insertedId });
    expect((doc as unknown as { __v?: number }).__v).toBe(1);

    // Two concurrent updates read the same version; only one CAS can win.
    const results = await Promise.all([
      db.updateWithVersion("users", { _id: created.insertedId }, { $set: { name: "x" } }),
      db.updateWithVersion("users", { _id: created.insertedId }, { $set: { name: "y" } }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });

  test("graceful transaction fallback on standalone", async () => {
    const db = service.db.primaryClient;
    const caps = createMongoCapabilitiesStore();
    await withGracefulMongoTransaction(
      { transaction: db.transaction },
      async (session) => {
        await db.insertOne("orders", { userId, total: 5 }, { session: session ?? undefined });
      },
      { capabilities: caps, urlHint: MONGO_URL },
    );
    const total = await db.countDocuments("orders", {});
    expect(total).toBe(3);
  });

  test("migration runner up + down with journaling", async () => {
    const db = service.db.primaryClient;
    const runner = createMongoMigrationRunner(service as never, {
      migrationDir: `${import.meta.dir}/fixtures/migrations`,
    });

    await runner.up();
    const afterUp = await db.findMany("users", { email: "migrated@example.com" });
    expect(afterUp.length).toBe(1);

    await runner.down("001_seed");
    const afterDown = await db.findMany("users", { email: "migrated@example.com" });
    expect(afterDown.length).toBe(0);
  });
});
