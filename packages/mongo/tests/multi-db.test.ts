/**
 * Multi-DB isolation of the shared query cache + in-flight dedup.
 *
 * One service can define several DB clients; they share a single QueryCache and
 * InFlight. Cache/dedup keys MUST be namespaced by DATABASE — otherwise
 * same-named physical collections in different databases would collide, and a
 * read on DB A could be served DB B's cached rows (or identical concurrent
 * reads across DBs could coalesce into one driver call returning the wrong DB's
 * data). These tests pin the isolation end-to-end against real MongoDB.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createMongoService, s } from "../src/index.ts";
import {
  MONGO_URL,
  maybeDescribe,
  probe as mongoProbe,
  noopLogger,
  serverQueryCount,
} from "./helpers.ts";

const userSchema = s.object(
  { _id: s.objectId(), email: s.string(), name: s.string() },
  { name: "users" },
);

type Clients = {
  a: { name: string; dbUrl: string; collections: { users: typeof userSchema } };
  b: { name: string; dbUrl: string; collections: { users: typeof userSchema } };
};

const maybe = maybeDescribe(await mongoProbe());

maybe("multi-DB cache + dedup isolation", () => {
  let service: ReturnType<typeof createMongoService<Clients>>;
  const dbA = "ninox_multi_a";
  const dbB = "ninox_multi_b";

  beforeAll(async () => {
    service = createMongoService<Clients>(
      {
        a: { name: dbA, dbUrl: MONGO_URL, collections: { users: userSchema } },
        b: { name: dbB, dbUrl: MONGO_URL, collections: { users: userSchema } },
      },
      { logger: noopLogger },
    );
    await service.makeConnections();
    const a = service.db.aClient;
    const b = service.db.bClient;
    await a.client.dropDatabase();
    await b.client.dropDatabase();
    await a.createSchema("users");
    await b.createSchema("users");
    // Same physical collection + same email in both DBs, DIFFERENT values.
    await a.insertOne("users", { email: "dup@x", name: "from-A" });
    await b.insertOne("users", { email: "dup@x", name: "from-B" });
  });

  afterAll(async () => {
    if (service) await service.closeConnections();
  });

  test("identical reads in different DBs do not share cache entries", async () => {
    const a = service.db.aClient;
    const b = service.db.bClient;
    const fromA = await a.getOne("users", { email: "dup@x" }); // caches A's row
    await a.getOne("users", { email: "dup@x" }); // cache hit
    expect(fromA?.name).toBe("from-A");
    // B's identical query must return B's row — NOT A's cached row.
    const fromB = await b.getOne("users", { email: "dup@x" });
    expect(fromB?.name).toBe("from-B");
    await b.getOne("users", { email: "dup@x" }); // B cache hit now
    expect((await a.getOne("users", { email: "dup@x" }))?.name).toBe("from-A");
  });

  test("identical concurrent reads across DBs each hit the DB (no cross-DB dedup)", async () => {
    const a = service.db.aClient;
    const b = service.db.bClient;
    const before = await serverQueryCount(a.client);
    const [ra, rb] = await Promise.all([
      a.getOne("users", { email: "dedup@x" }), // fresh miss → must run a driver query
      b.getOne("users", { email: "dedup@x" }),
    ]);
    const after = await serverQueryCount(a.client);
    expect(ra).toBeNull();
    expect(rb).toBeNull();
    // Different DBs → two distinct dedupe keys → two driver queries, not one.
    expect(after - before).toBeGreaterThanOrEqual(2);
  });

  test("a write to DB A does not invalidate DB B cached reads", async () => {
    const a = service.db.aClient;
    const b = service.db.bClient;
    await b.getOne("users", { email: "dup@x" }); // ensure B's row is cached
    const before = await serverQueryCount(a.client);
    await a.updateOne("users", { email: "dup@x" }, { $set: { name: "from-A2" } });
    const afterWrite = await serverQueryCount(a.client);
    // B's read must be a cache HIT (A's write only invalidates the `dbA` namespace).
    const cached = await b.getOne("users", { email: "dup@x" });
    const after = await serverQueryCount(a.client);
    expect(cached?.name).toBe("from-B");
    expect(after - afterWrite).toBe(0);
  });

  test("identical aggregations in different DBs do not share cache entries", async () => {
    const a = service.db.aClient;
    const b = service.db.bClient;
    const agg = (m: { pipeline: typeof a.pipeline }) =>
      m
        .pipeline("users")
        .group({ _id: "$email", n: { $sum: 1 } })
        .sort({ _id: 1 })
        .toArray();

    // Cache A's aggregation; B's identical one must be a cold miss (different
    // db-namespaced key) → one driver query for B.
    await agg(a);
    await agg(a); // A warm
    const before = await serverQueryCount(a.client);
    await agg(a); // A cache hit → 0 driver queries
    const afterAWarm = await serverQueryCount(a.client);
    expect(afterAWarm - before).toBe(0);

    const beforeB = await serverQueryCount(a.client);
    const fromB = await agg(b);
    const afterB = await serverQueryCount(a.client);
    expect(afterB - beforeB).toBe(1); // B's aggregation missed (no cross-DB sharing)
    expect(fromB.length).toBeGreaterThan(0);

    // A write to DB A must NOT invalidate DB B's cached aggregation.
    await agg(b); // B warm
    await a.insertOne("users", { email: "new@x", name: "from-A3" });
    const beforeB2 = await serverQueryCount(a.client);
    await agg(b); // B cache hit → 0 driver queries (A's write didn't touch B)
    const afterB2 = await serverQueryCount(a.client);
    expect(afterB2 - beforeB2).toBe(0);
  });
});
