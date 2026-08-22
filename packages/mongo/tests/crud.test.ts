import { describe, expect, test } from "bun:test";
import type { Db, Document } from "mongodb";
import { cacheCollectionKey, QueryCache } from "../src/cache/query-cache.ts";
import { BadRequest } from "../src/errors/index.ts";
import { makeCrudOps } from "../src/service/crud/index.ts";
import { stableHash } from "../src/utils/hash.ts";
import type { LoggerLike } from "../src/utils/logger.ts";

const noopLogger: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} };

interface FakeCollection {
  findOne?: (filter: Document, options?: Document) => Promise<Document | null>;
  find?: (filter: Document, options?: Document) => { toArray(): Promise<Document[]> };
  insertOne?: (doc: Document) => Promise<{ insertedId: unknown }>;
  insertMany?: (docs: Document[]) => Promise<{ insertedCount: number }>;
  updateOne?: (
    filter: Document,
    update: Document,
    options?: Document,
  ) => Promise<{ matchedCount: number; upsertedCount: number }>;
  updateMany?: () => Promise<unknown>;
  findOneAndUpdate?: (filter: Document, update: Document) => Promise<Document | null>;
  findOneAndReplace?: () => Promise<Document | null>;
  deleteOne?: () => Promise<{ deletedCount: number }>;
  deleteMany?: () => Promise<{ deletedCount: number }>;
  countDocuments?: () => Promise<number>;
  bulkWrite?: (ops: unknown) => Promise<unknown>;
  watch?: () => unknown;
}

const makeCrud = (collection: FakeCollection, opts: Record<string, unknown> = {}): any => {
  const fakeDb = {
    // `databaseName` namespaces cache keys — reads and write-through
    // invalidation must agree on it (see `cacheCollectionKey`).
    databaseName: "test",
    collection: () => collection,
  } as unknown as Db;
  return makeCrudOps<any, any>(fakeDb, "test", noopLogger, {
    resolveCollectionName: (logical: string) => logical,
    ...opts,
  });
};

describe("CRUD ops", () => {
  test("getOneOrFail throws NOT_FOUND when missing", async () => {
    const crud = makeCrud({ findOne: async () => null });
    await expect(crud.getOneOrFail("users", { _id: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("getOneOrFail returns the doc when found", async () => {
    const crud = makeCrud({ findOne: async () => ({ _id: "1", email: "a@b.c" }) });
    await expect(crud.getOneOrFail("users", { _id: "1" })).resolves.toMatchObject({
      email: "a@b.c",
    });
  });

  test("findMany defaults limit to 100", async () => {
    let seenOptions: Document | undefined;
    const crud = makeCrud({
      find: (_f, options) => {
        seenOptions = options as Document;
        return { toArray: async () => [] };
      },
    });
    await crud.findMany("users", {});
    expect(seenOptions?.limit).toBe(100);
  });

  test("findMany select translates to a driver projection (select stripped)", async () => {
    let seenOptions: Document | undefined;
    const crud = makeCrud({
      find: (_f, options) => {
        seenOptions = options as Document;
        return { toArray: async () => [] };
      },
    });
    await crud.findMany("users", {}, { select: ["_id", "email"] });
    expect(seenOptions?.projection).toEqual({ _id: 1, email: 1 });
    expect(seenOptions?.select).toBeUndefined();
  });

  test("insertMany rejects batches above MAX_BATCH_OPS", async () => {
    const crud = makeCrud({ insertMany: async () => ({ insertedCount: 0 }) });
    const big = new Array(100_001).fill({ email: "x@y.z", role: "admin", createdAt: new Date() });
    await expect(crud.insertMany("users", big)).rejects.toThrow(BadRequest);
  });

  test("findMany select keeps the default limit", async () => {
    let seenOptions: Document | undefined;
    const crud = makeCrud({
      find: (_f, options) => {
        seenOptions = options as Document;
        return { toArray: async () => [] };
      },
    });
    await crud.findMany("users", {}, { select: ["email"] });
    expect(seenOptions?.projection).toEqual({ email: 1 });
    expect(seenOptions?.limit).toBe(100);
  });

  test("getOne select translates to a driver projection", async () => {
    let seenOptions: Document | undefined;
    const crud = makeCrud({
      findOne: async (_f, options) => {
        seenOptions = options as Document;
        return { _id: "1", email: "a@b.c" };
      },
    });
    await crud.getOne("users", { _id: "1" }, { select: ["email"] });
    expect(seenOptions?.projection).toEqual({ email: 1 });
    expect(seenOptions?.select).toBeUndefined();
  });

  test("insertOne fires before/after hooks", async () => {
    const events: string[] = [];
    const crud = makeCrud(
      { insertOne: async (_doc) => ({ insertedId: "id" }) },
      {
        hooks: {
          users: {
            beforeCreate: () => {
              events.push("before");
            },
            afterCreate: () => {
              events.push("after");
            },
          },
        },
      },
    );
    await crud.insertOne("users", { email: "a@b.c" });
    expect(events).toEqual(["before", "after"]);
  });

  test("writes invalidate the query cache for the collection", async () => {
    const cache = new QueryCache();
    const crud = makeCrud({ insertOne: async () => ({ insertedId: "id" }) }, { cache });
    // Cache keys are namespaced by database (fake Db uses `test`).
    const key = cache.key(
      cacheCollectionKey("test", "users"),
      stableHash([{ role: "admin" }, undefined]),
    );
    cache.set(key, [{ role: "admin" }]);
    expect(cache.get(key)).toBeDefined();
    await crud.insertOne("users", { email: "a@b.c" });
    expect(cache.get(key)).toBeUndefined();
  });

  test("upsert wraps plain update in $set + upsert:true", async () => {
    let updateSent: Document | undefined;
    let optionsSent: Document | undefined;
    const crud = makeCrud({
      updateOne: async (_f, update, options) => {
        updateSent = update;
        optionsSent = options as Document;
        return { matchedCount: 0, upsertedCount: 1 };
      },
    });
    await crud.upsert("users", { _id: "1" }, { email: "a@b.c" });
    expect(updateSent).toEqual({ $set: { email: "a@b.c" } });
    expect(optionsSent?.upsert).toBe(true);
  });

  test("updateWithVersion returns version_conflict on CAS miss", async () => {
    const crud = makeCrud({
      findOne: async () => ({ _id: "1", __v: 3 }),
      findOneAndUpdate: async () => null, // CAS failed
    });
    const result = await crud.updateWithVersion("users", { _id: "1" }, { $set: { a: 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("version_conflict");
  });

  test("softDeleteOne sets deletedAt on active rows", async () => {
    let filterSent: Document | undefined;
    let updateSent: Document | undefined;
    const crud = makeCrud({
      updateOne: async (filter, update) => {
        filterSent = filter as Document;
        updateSent = update as Document;
        return { matchedCount: 1, upsertedCount: 0 };
      },
    });
    await crud.softDeleteOne("users", { _id: "1" });
    expect(filterSent?.$and?.[0]).toEqual({ _id: "1" });
    expect((updateSent as Document).$set.deletedAt).toBeInstanceOf(Date);
  });

  test("maps driver duplicate key when wrapMongoErrors is on", async () => {
    const crud = makeCrud(
      {
        insertOne: async () => {
          const err = new Error("dup") as Error & { code: number; keyPattern: Document };
          err.code = 11000;
          err.keyPattern = { email: 1 };
          throw err;
        },
      },
      { wrapMongoErrors: true },
    );
    await expect(crud.insertOne("users", { email: "a@b.c" })).rejects.toMatchObject({
      code: "DUPLICATE_KEY",
    });
  });
});
