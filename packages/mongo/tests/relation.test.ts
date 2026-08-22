import { describe, expect, test } from "bun:test";
import type { Document, Filter } from "mongodb";
import { makePopulator } from "../src/relation/populate.ts";
import { belongsTo, hasMany, manyToMany } from "../src/relation/relation.ts";

interface Row {
  _id: string;
  [key: string]: unknown;
}

const makeFakeDb = (db: Record<string, Row[]>) => {
  const queries: string[] = [];
  const deps = {
    queries,
    findMany: async (collection: string, filter: Filter<Document>) => {
      queries.push(collection);
      const field = Object.keys(filter)[0]!;
      const inValues = (filter[field] as { $in?: unknown[] })?.$in ?? [];
      return db[collection]?.filter((doc) => inValues.includes(doc[field])) ?? [];
    },
  };
  return { deps, queries };
};

describe("populate (DataLoader-batched relations)", () => {
  test("belongsTo resolves with a single batched query", async () => {
    const { deps, queries } = makeFakeDb({
      users: [
        { _id: "u1", name: "Alice" },
        { _id: "u2", name: "Bob" },
      ],
    });
    const populator = makePopulator(deps);
    const orders = [
      { _id: "o1", userId: "u1" },
      { _id: "o2", userId: "u2" },
    ] as Array<Row & Record<string, unknown>>;

    await populator.populate(orders, [
      belongsTo({ collection: "users", localField: "userId", as: "customer" }),
    ]);

    expect(orders[0]!.customer).toMatchObject({ _id: "u1", name: "Alice" });
    expect(orders[1]!.customer).toMatchObject({ _id: "u2", name: "Bob" });
    // One batch query for the whole relation — no N+1.
    expect(queries).toEqual(["users"]);
  });

  test("belongsTo attaches null when the target is missing", async () => {
    const { deps } = makeFakeDb({ users: [] });
    const populator = makePopulator(deps);
    const docs = [{ _id: "o1", userId: "u-missing" }] as Array<Row & Record<string, unknown>>;
    await populator.populate(docs, [
      belongsTo({ collection: "users", localField: "userId", as: "customer" }),
    ]);
    expect(docs[0]!.customer).toBeNull();
  });

  test("hasMany resolves an array per source doc", async () => {
    const { deps, queries } = makeFakeDb({
      orders: [
        { _id: "o1", userId: "u1", total: 10 },
        { _id: "o2", userId: "u1", total: 20 },
        { _id: "o3", userId: "u2", total: 5 },
      ],
    });
    const populator = makePopulator(deps);
    const users = [
      { _id: "u1", name: "Alice" },
      { _id: "u2", name: "Bob" },
    ] as Array<Row & Record<string, unknown>>;

    await populator.populate(users, [
      hasMany({ collection: "orders", localField: "_id", foreignField: "userId", as: "orders" }),
    ]);

    expect(users[0]!.orders).toHaveLength(2);
    expect(users[1]!.orders).toHaveLength(1);
    expect(queries).toEqual(["orders"]);
  });

  test("manyToMany resolves through the join collection in two hops", async () => {
    const { deps, queries } = makeFakeDb({
      memberships: [
        { _id: "m1", teamId: "t1", memberId: "u1" },
        { _id: "m2", teamId: "t1", memberId: "u2" },
      ],
      users: [
        { _id: "u1", name: "Alice" },
        { _id: "u2", name: "Bob" },
      ],
    });
    const populator = makePopulator(deps);
    const teams = [{ _id: "t1", name: "Core" }] as Array<Row & Record<string, unknown>>;

    await populator.populate(teams, [
      manyToMany({
        collection: "users",
        localField: "_id",
        through: { collection: "memberships", localField: "teamId", foreignField: "memberId" },
        as: "members",
      }),
    ]);

    expect(teams[0]!.members).toHaveLength(2);
    expect((teams[0]!.members as Row[]).map((m) => m.name).sort()).toEqual(["Alice", "Bob"]);
    expect(queries).toEqual(["memberships", "users"]);
  });

  test("100 source docs cause exactly 1 batched query per relation (N+1 eliminated)", async () => {
    const users = Array.from({ length: 100 }, (_, i) => ({ _id: `u${i}`, name: `U${i}` }));
    const { deps, queries } = makeFakeDb({ users });
    const populator = makePopulator(deps);
    const docs = Array.from({ length: 100 }, (_, i) => ({
      _id: `o${i}`,
      userId: `u${i}`,
    })) as Array<Row & Record<string, unknown>>;

    await populator.populate(docs, [
      belongsTo({ collection: "users", localField: "userId", as: "user" }),
    ]);

    expect(docs[42]!.user).toMatchObject({ _id: "u42" });
    expect(queries).toEqual(["users"]);
  });
});
