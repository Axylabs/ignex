import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ClientSession, type Db, ObjectId } from "mongodb";
import { InFlight } from "../src/cache/in-flight.ts";
import { QueryCache } from "../src/cache/query-cache.ts";
import { probeMongoCapabilities } from "../src/capabilities.ts";
import { DataLoader } from "../src/loader/dataloader.ts";
import { belongsTo, hasMany } from "../src/relation/relation.ts";
import { s } from "../src/schema/index.ts";
import { createMongoService } from "../src/service/index.ts";
import { MONGO_URL, maybeDescribe, noopLogger, probe, serverQueryCount } from "./helpers.ts";

const userSchema = s.object({
  _id: s.objectId(),
  email: s.string(),
  role: s.enum(["admin", "user"] as const),
  createdAt: s.date(),
});
const orderSchema = s.object({
  _id: s.objectId(),
  userId: s.objectId(),
  total: s.number({ minimum: 0 }),
  status: s.string().optional(),
});

/* ------------------------------------------------------------------ *
 * Component-level tests for the optimization primitives themselves.
 * These are pure utility classes (no Mongo, no ORM wiring) — the ORM
 * just wires them into the read path, which the guarded block below
 * exercises for real.
 * ------------------------------------------------------------------ */
describe("optimization primitives (component-level, no Mongo)", () => {
  test("InFlight: a rejected run is cleaned up — later calls re-run", async () => {
    const inflight = new InFlight();
    let fail = true;
    let runs = 0;
    const run = () =>
      inflight.run("k", async () => {
        runs++;
        if (fail) throw new Error("boom");
        return "ok";
      });
    await expect(Promise.all([run(), run()])).rejects.toThrow("boom");
    expect(runs).toBe(1); // coalesced
    expect(inflight.size).toBe(0); // failed promise evicted
    fail = false;
    expect(await run()).toBe("ok"); // fresh run, not the rejected promise
    expect(runs).toBe(2);
  });

  test("DataLoader: results resolve in load order regardless of batch order", async () => {
    const loader = new DataLoader<string, string>({
      batch: async (keys) => {
        const map = new Map<string, string>();
        for (const k of [...keys].reverse()) map.set(k, k.toUpperCase());
        return map;
      },
    });
    expect(await loader.loadMany(["a", "b", "c"])).toEqual(["A", "B", "C"]);
  });

  test("DataLoader: cache:false disables caching (no hidden cache)", async () => {
    let n = 0;
    const loader = new DataLoader<string, string>({
      cache: false,
      batch: async (keys) => {
        n++;
        const map = new Map<string, string>();
        for (const k of keys) map.set(k, k);
        return map;
      },
    });
    await loader.load("x");
    await loader.load("x");
    expect(n).toBe(2);
  });

  test("DataLoader: a failed batch is NOT cached — a later load retries", async () => {
    let n = 0;
    const loader = new DataLoader<string, string>({
      batch: async () => {
        n++;
        throw new Error("boom");
      },
    });
    await expect(loader.load("a")).rejects.toThrow("boom");
    await expect(loader.load("a")).rejects.toThrow("boom"); // evicted → fresh batch run
    expect(n).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Real ORM: every test below goes through createMongoService → manager
 * against a real MongoDB (guarded by a connectivity probe), so broken ORM
 * wiring (config resolution, cache invalidation, the perf switch) fails
 * the test instead of being masked by fakes.
 *
 * To observe caching WITHOUT fake collections we use the manager's raw
 * `client` escape hatch: write directly to the underlying collection
 * (bypassing the ORM → no invalidation) and confirm the ORM still returns
 * the OLD cached value — proving the cache is genuinely active — then
 * confirm an ORM write invalidates it and returns fresh data.
 * ------------------------------------------------------------------ */
const available = await probe();
const maybe = maybeDescribe(available);

maybe("automatic optimizations — real ORM, no side effects", () => {
  const perfOn = createMongoService(
    {
      primary: {
        name: "ninox_perf_on",
        dbUrl: MONGO_URL,
        collections: { users: userSchema, orders: orderSchema },
      },
    },
    { logger: noopLogger, cache: new QueryCache({ maxSize: 200 }), dedupeReads: true },
  );
  const perfOff = createMongoService(
    {
      primary: {
        name: "ninox_perf_off",
        dbUrl: MONGO_URL,
        collections: { users: userSchema, orders: orderSchema },
      },
    },
    { logger: noopLogger, perf: false },
  );
  const dedupOn = createMongoService(
    {
      primary: {
        name: "ninox_perf_dedup",
        dbUrl: MONGO_URL,
        collections: { users: userSchema, orders: orderSchema },
      },
    },
    { logger: noopLogger, cache: null, dedupeReads: true },
  );
  const perfTtl = createMongoService(
    {
      primary: {
        name: "ninox_perf_ttl",
        dbUrl: MONGO_URL,
        collections: { users: userSchema, orders: orderSchema },
      },
    },
    { logger: noopLogger, cache: { maxSize: 100, ttlMs: 40 } },
  );

  let db: any; // perf-on manager
  let raw: Db; // raw handle to the perf-on DB
  let off: any; // perf-off manager
  let dedup: any; // dedup-only manager (cache off)
  let ttl: any; // TTL-cached manager

  const makeUser = (email: string) => ({ email, role: "admin" as const, createdAt: new Date() });

  beforeAll(async () => {
    await Promise.all([
      perfOn.makeConnections(),
      perfOff.makeConnections(),
      dedupOn.makeConnections(),
      perfTtl.makeConnections(),
    ]);
    db = perfOn.db.primaryClient;
    raw = db.client;
    off = perfOff.db.primaryClient;
    dedup = dedupOn.db.primaryClient;
    ttl = perfTtl.db.primaryClient;
    for (const manager of [db, off, dedup, ttl]) {
      await manager.client.dropCollection("users").catch(() => {});
      await manager.client.dropCollection("orders").catch(() => {});
      await manager.createSchema("users");
      await manager.createSchema("orders");
    }
  });

  afterAll(async () => {
    await Promise.all([
      perfOn.closeConnections(),
      perfOff.closeConnections(),
      dedupOn.closeConnections(),
      perfTtl.closeConnections(),
    ]);
  });

  describe("query cache (real ORM) — write-through invalidation, no stale reads", () => {
    /** Prime the cache with `email`, then change the row externally so only a cache hit reveals the old value. */
    const primeThenExternallyMutate = async (email: string): Promise<ObjectId> => {
      const { insertedId } = await db.insertOne("users", makeUser(email));
      expect((await db.getOne("users", { _id: insertedId }))?.email).toBe(email); // cold read → caches
      await raw
        .collection("users")
        .updateOne({ _id: insertedId }, { $set: { email: "external@x.y" } });
      // If the cache is ACTIVE the ORM must return the OLD value here.
      expect((await db.getOne("users", { _id: insertedId }))?.email).toBe(email);
      return insertedId as ObjectId;
    };

    const writeOps: Array<[string, (id: ObjectId) => Promise<unknown>]> = [
      ["insertOne", () => db.insertOne("users", makeUser("orm@x.y"))],
      ["insertMany", () => db.insertMany("users", [makeUser("orm@x.y")])],
      ["updateOne", (id) => db.updateOne("users", { _id: id }, { $set: { email: "orm@x.y" } })],
      ["updateMany", (id) => db.updateMany("users", { _id: id }, { $set: { email: "orm@x.y" } })],
      [
        "findOneAndUpdate",
        (id) => db.findOneAndUpdate("users", { _id: id }, { $set: { email: "orm@x.y" } }),
      ],
      [
        "findOneAndReplace",
        (id) =>
          db.findOneAndReplace(
            "users",
            { _id: id },
            { _id: id, email: "orm@x.y", role: "admin", createdAt: new Date() },
          ),
      ],
      ["deleteOne", (id) => db.deleteOne("users", { _id: id })],
      ["deleteMany", (id) => db.deleteMany("users", { _id: id })],
      ["softDeleteOne", (id) => db.softDeleteOne("users", { _id: id })],
      ["upsert", (id) => db.upsert("users", { _id: id }, { $set: { email: "orm@x.y" } })],
      [
        "bulkUpsert",
        (id) =>
          db.bulkUpsert("users", [{ filter: { _id: id }, update: { $set: { email: "orm@x.y" } } }]),
      ],
      [
        "updateWithVersion",
        (id) => db.updateWithVersion("users", { _id: id }, { $set: { email: "orm@x.y" } }),
      ],
    ];

    for (const [opName, write] of writeOps) {
      test(`${opName} invalidates cached reads for its collection`, async () => {
        const id = await primeThenExternallyMutate(`prime-${opName}@x.y`);
        await write(id);
        // After an ORM write the cache must be gone → the external value shows
        // through, never the stale cached one.
        const fresh = await db.getOne("users", { _id: id });
        expect(fresh?.email).not.toBe(`prime-${opName}@x.y`);
      });
    }

    test("a write to orders does NOT invalidate cached users (per-collection)", async () => {
      const { insertedId } = await db.insertOne("users", makeUser("cross@x.y"));
      await db.getOne("users", { _id: insertedId }); // cache users
      await raw
        .collection("users")
        .updateOne({ _id: insertedId }, { $set: { email: "external@x.y" } });
      expect((await db.getOne("users", { _id: insertedId }))?.email).toBe("cross@x.y"); // users cache active

      await db.insertOne("orders", { userId: insertedId, total: 5 }); // ORM write to ORDERS
      expect((await db.getOne("users", { _id: insertedId }))?.email).toBe("cross@x.y"); // users cache untouched

      await db.updateOne("users", { _id: insertedId }, { $set: { email: "orm@x.y" } }); // ORM write to users
      expect((await db.getOne("users", { _id: insertedId }))?.email).toBe("orm@x.y"); // now invalidated → fresh
    });

    test("`cache: false` reads bypass the cache and never populate it", async () => {
      const { insertedId } = await db.insertOne("users", makeUser("bypass@x.y"));
      await db.getOne("users", { _id: insertedId }); // prime cache with 'bypass@x.y'
      await raw
        .collection("users")
        .updateOne({ _id: insertedId }, { $set: { email: "external@x.y" } });

      const bypass = await db.getOne("users", { _id: insertedId }, { cache: false });
      expect(bypass?.email).toBe("external@x.y"); // bypassed → fresh, not the cached value

      const hit = await db.getOne("users", { _id: insertedId }); // normal read still sees the cache
      expect(hit?.email).toBe("bypass@x.y"); // and the bypass did NOT overwrite it
    });

    test("a not-found read caches null and is invalidated by an ORM write", async () => {
      const id = new ObjectId(); // guaranteed absent
      expect(await db.getOne("users", { _id: id })).toBeNull(); // caches null
      await raw.collection("users").insertOne({ _id: id, ...makeUser("ext@x.y") });
      expect(await db.getOne("users", { _id: id })).toBeNull(); // external insert → still cached null

      await db.insertOne("users", makeUser("invalidate@x.y")); // ORM write invalidates users
      expect((await db.getOne("users", { _id: id }))?.email).toBe("ext@x.y"); // fresh now
    });

    test("cached entries expire after the TTL — reads go fresh again", async () => {
      const { insertedId } = await ttl.insertOne("users", makeUser("ttl@x.y"));
      await ttl.getOne("users", { _id: insertedId }); // cache
      await ttl.client
        .collection("users")
        .updateOne({ _id: insertedId }, { $set: { email: "external@x.y" } });
      expect((await ttl.getOne("users", { _id: insertedId }))?.email).toBe("ttl@x.y"); // hit before TTL
      await new Promise((r) => setTimeout(r, 70));
      expect((await ttl.getOne("users", { _id: insertedId }))?.email).toBe("external@x.y"); // expired → fresh
    });
  });

  describe("in-flight dedup (real ORM) — coalescing + correctness", () => {
    test("concurrent identical reads all succeed with the same value", async () => {
      const { insertedId } = await db.insertOne("orders", { userId: new ObjectId(), total: 3 });
      const values = await Promise.all([
        db.countDocuments("orders", { _id: insertedId }),
        db.countDocuments("orders", { _id: insertedId }),
        db.countDocuments("orders", { _id: insertedId }),
      ]);
      expect(values).toEqual([1, 1, 1]);
    });

    test("concurrent reads with different filters return their own results (no over-merge)", async () => {
      await db.insertMany("orders", [
        { userId: new ObjectId(), total: 1, status: "a" },
        { userId: new ObjectId(), total: 2, status: "b" },
      ]);
      const [a, b] = await Promise.all([
        db.countDocuments("orders", { status: "a" }),
        db.countDocuments("orders", { status: "b" }),
      ]);
      expect(a).toBe(1);
      expect(b).toBe(1);
    });

    test("reads inside a transaction stay correct", async () => {
      const { insertedId } = await db.insertOne("orders", { userId: new ObjectId(), total: 4 });
      const caps = await probeMongoCapabilities(db.client);
      const values = await (caps.transactionsSupported
        ? // A real transaction session can only run ONE operation at a time —
          // MongoDB rejects concurrent ops on a session ("Only servers in a
          // sharded cluster..."), so reads run sequentially here. Correctness
          // (values are read from the transaction) is what's being pinned.
          db.transaction(async (session: ClientSession | null) => {
            const first = await db.countDocuments(
              "orders",
              { _id: insertedId },
              { session: session ?? undefined },
            );
            const second = await db.countDocuments(
              "orders",
              { _id: insertedId },
              { session: session ?? undefined },
            );
            return [first, second];
          })
        : // Standalone graceful fallback runs the callback with a null session →
          // no transaction, so concurrent identical reads are safe (deduped).
          db.transaction(async (session: ClientSession | null) =>
            Promise.all([
              db.countDocuments("orders", { _id: insertedId }, { session: session ?? undefined }),
              db.countDocuments("orders", { _id: insertedId }, { session: session ?? undefined }),
            ]),
          ));
      expect(values).toEqual([1, 1]);
    });

    test("dedup coalesces N concurrent identical reads into ~1 server query (vs N with it off)", async () => {
      const { insertedId } = await dedup.insertOne("orders", { userId: new ObjectId(), total: 5 });
      const q0 = await serverQueryCount(dedup.client);
      await Promise.all(
        Array.from({ length: 12 }, () => dedup.countDocuments("orders", { _id: insertedId })),
      );
      const dOn = (await serverQueryCount(dedup.client)) - q0;

      const { insertedId: offId } = await off.insertOne("orders", {
        userId: new ObjectId(),
        total: 5,
      });
      const q1 = await serverQueryCount(off.client);
      await Promise.all(
        Array.from({ length: 12 }, () => off.countDocuments("orders", { _id: offId })),
      );
      const dOff = (await serverQueryCount(off.client)) - q1;

      expect(dOn).toBeLessThanOrEqual(3); // coalesced → ~1 (tolerance for ambient traffic)
      expect(dOff).toBeGreaterThanOrEqual(12); // dedup off → one query per caller
      expect(dOn).toBeLessThan(dOff);
    });
  });

  describe("$facet pagination (real ORM)", () => {
    test("returns data + totalCount from a single aggregate with correct page math", async () => {
      const userId = new ObjectId();
      await db.insertMany("orders", [
        { userId, total: 10 },
        { userId, total: 20 },
        { userId, total: 30 },
      ]);
      const page = await db.paginateFlexible(
        "orders",
        { userId },
        { page: 2, limit: 1, sort: { total: -1 } },
      );
      expect(page.totalCount).toBe(3);
      expect(page.totalPages).toBe(3);
      expect(page.data).toHaveLength(1);
      expect(page.data[0].total).toBe(20); // desc: 30,20,10 → page 2 = 20
    });
  });

  describe("populate (real ORM) — no side effects", () => {
    test("belongsTo attaches only the `as` field; source fields untouched", async () => {
      const { insertedId: userId } = await db.insertOne("users", makeUser("pop@x.y"));
      const { insertedId: orderId } = await db.insertOne("orders", { userId, total: 5 });
      const orders = await db.findMany("orders", { _id: orderId });
      const snapshot = { ...orders[0] };

      const populated = await db.populate(orders, [
        belongsTo({ collection: "users", localField: "userId", as: "customer" }),
      ]);

      expect(populated).toBe(orders); // same array, mutated in place
      expect(populated[0].customer).toMatchObject({ _id: userId });
      const { customer: _c, ...rest } = { ...populated[0] };
      expect(rest).toEqual(snapshot); // nothing but `as` changed
    });

    test("a second populate call re-queries — no stale joins across calls", async () => {
      const { insertedId: userId } = await db.insertOne("users", makeUser("fresh@x.y"));
      const { insertedId: orderId } = await db.insertOne("orders", { userId, total: 5 });
      const orders = await db.findMany("orders", { _id: orderId });

      await db.populate(orders, [
        belongsTo({ collection: "users", localField: "userId", as: "customer" }),
      ]);
      expect(orders[0].customer.email).toBe("fresh@x.y");

      await raw.collection("users").updateOne({ _id: userId }, { $set: { email: "changed@x.y" } });
      await db.populate(orders, [
        belongsTo({ collection: "users", localField: "userId", as: "customer" }),
      ]);
      expect(orders[0].customer.email).toBe("changed@x.y"); // fresh query per populate call
    });

    test("hasMany attaches an array per source doc", async () => {
      const { insertedId: userId } = await db.insertOne("users", makeUser("many@x.y"));
      await db.insertMany("orders", [
        { userId, total: 1 },
        { userId, total: 2 },
      ]);
      const users = await db.findMany("users", { _id: userId });
      await db.populate(users, [
        hasMany({ collection: "orders", localField: "_id", foreignField: "userId", as: "orders" }),
      ]);
      expect(users[0].orders).toHaveLength(2);
    });
  });

  test("perf-on and perf-off return identical results (optimizations change nothing observable)", async () => {
    const scenario = async (manager: any) => {
      const { insertedId } = await manager.insertOne("users", makeUser("parity@x.y"));
      const before = await manager.getOne("users", { _id: insertedId });
      await manager.updateOne("users", { _id: insertedId }, { $set: { email: "parity2@x.y" } });
      const after = await manager.getOne("users", { _id: insertedId });
      await manager.insertMany("orders", [
        { userId: insertedId, total: 7 },
        { userId: insertedId, total: 9 },
      ]);
      const page = await manager.paginateFlexible(
        "orders",
        { userId: insertedId },
        { page: 1, limit: 1, sort: { total: -1 } },
      );
      const orders = await manager.findMany("orders", { userId: insertedId });
      await manager.populate(orders, [
        belongsTo({ collection: "users", localField: "userId", as: "customer" }),
      ]);
      return {
        before: before?.email,
        after: after?.email,
        pageTotal: page.totalCount,
        pageLen: page.data.length,
        topTotal: page.data[0]?.total,
        customerEmail: orders[0]?.customer?.email,
        orderKeys: Object.keys(orders[0] ?? {}).sort(),
      };
    };

    const on = await scenario(db);
    const without = await scenario(off);

    expect(on.after).toBe("parity2@x.y"); // read-after-write returns FRESH data (cache invalidated)
    expect(on).toEqual(without); // perf on vs perf off → identical observable behavior
    expect(on.pageTotal).toBe(2);
    expect(on.pageLen).toBe(1);
    expect(on.topTotal).toBe(9);
    expect(on.customerEmail).toBe("parity2@x.y");
    expect(on.orderKeys).toEqual(["_id", "customer", "total", "userId"]);
  });
});
