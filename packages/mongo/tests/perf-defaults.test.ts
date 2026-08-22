import { describe, expect, test } from "bun:test";
import type { Db, Document } from "mongodb";
import { InFlight } from "../src/cache/in-flight.ts";
import { QueryCache, type QueryCacheOptions } from "../src/index.ts";
import { makeCrudOps } from "../src/service/crud/index.ts";
import { resolveCache } from "../src/service/index.ts";
import type { LoggerLike } from "../src/utils/logger.ts";

const noopLogger: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} };

const makeCrud = (collection: Record<string, unknown>, opts: Record<string, unknown> = {}): any => {
  const fakeDb = { collection: () => collection } as unknown as Db;
  return makeCrudOps<any, any>(fakeDb, "test", noopLogger, {
    resolveCollectionName: (logical: string) => logical,
    ...opts,
  });
};

describe("resolveCache (perf-by-default config)", () => {
  test("undefined creates a default QueryCache", () => {
    const cache = resolveCache(undefined);
    expect(cache).toBeInstanceOf(QueryCache);
  });

  test("null disables caching", () => {
    expect(resolveCache(null)).toBeUndefined();
  });

  test("QueryCacheOptions constructs a configured cache", () => {
    const opts: QueryCacheOptions = { maxSize: 42, ttlMs: 100 };
    const cache = resolveCache(opts);
    expect(cache).toBeInstanceOf(QueryCache);
    expect(cache?.size).toBe(0);
  });

  test("a QueryCache instance is reused as-is", () => {
    const instance = new QueryCache({ maxSize: 7 });
    expect(resolveCache(instance)).toBe(instance);
  });
});

describe("read pipeline: cache + dedup defaults and opt-outs", () => {
  test("cache hit serves a repeat read with zero driver calls", async () => {
    let driverCalls = 0;
    const cache = new QueryCache();
    const crud = makeCrud(
      {
        find: () => {
          driverCalls++;
          return { toArray: async () => [{ _id: "1", email: "a@b.c" }] };
        },
      },
      { cache, dedupeReads: true },
    );

    await crud.findMany("users", { email: "a@b.c" });
    await crud.findMany("users", { email: "a@b.c" });
    expect(driverCalls).toBe(1); // second read is a cache hit
  });

  test("per-op `cache: false` bypasses the service cache", async () => {
    let driverCalls = 0;
    const cache = new QueryCache();
    const crud = makeCrud(
      {
        find: () => {
          driverCalls++;
          return { toArray: async () => [] };
        },
      },
      { cache, dedupeReads: true },
    );

    await crud.findMany("users", {}, { cache: false });
    await crud.findMany("users", {}, { cache: false });
    expect(driverCalls).toBe(2); // each bypasses the cache
  });

  test("identical concurrent reads dedupe to one driver call when dedupeReads is on", async () => {
    let driverCalls = 0;
    const crud = makeCrud(
      {
        countDocuments: async () => {
          driverCalls++;
          await new Promise((r) => setTimeout(r, 5));
          return 3;
        },
      },
      { cache: undefined, dedupeReads: true, inFlight: new InFlight() },
    );

    const counts = await Promise.all([
      crud.countDocuments("orders", { status: "paid" }),
      crud.countDocuments("orders", { status: "paid" }),
      crud.countDocuments("orders", { status: "paid" }),
    ]);
    expect(counts).toEqual([3, 3, 3]);
    expect(driverCalls).toBe(1);
  });

  test("per-op `dedupe: false` opts out of dedup even with service default on", async () => {
    let driverCalls = 0;
    const crud = makeCrud(
      {
        countDocuments: async () => {
          driverCalls++;
          return 3;
        },
      },
      { cache: undefined, dedupeReads: true, inFlight: new InFlight() },
    );

    await Promise.all([
      crud.countDocuments("orders", {}, { dedupe: false }),
      crud.countDocuments("orders", {}, { dedupe: false }),
    ]);
    expect(driverCalls).toBe(2);
  });

  test("per-op `dedupe: true` forces dedup even with service default off", async () => {
    let driverCalls = 0;
    const crud = makeCrud(
      {
        countDocuments: async () => {
          driverCalls++;
          return 3;
        },
      },
      { cache: undefined, dedupeReads: false, inFlight: new InFlight() },
    );

    const counts = await Promise.all([
      crud.countDocuments("orders", {}, { dedupe: true }),
      crud.countDocuments("orders", {}, { dedupe: true }),
    ]);
    expect(counts).toEqual([3, 3]);
    expect(driverCalls).toBe(1);
  });

  test("sessions bypass cache and dedup (transactional reads)", async () => {
    let driverCalls = 0;
    const cache = new QueryCache();
    const crud = makeCrud(
      {
        findOne: async () => {
          driverCalls++;
          return { _id: "1" };
        },
      },
      { cache, dedupeReads: true },
    );

    const session = {} as never;
    await crud.getOne("users", {}, { session });
    await crud.getOne("users", {}, { session });
    expect(driverCalls).toBe(2); // session reads never cache/dedupe
  });

  test("writes invalidate the cache for the collection", async () => {
    let driverCalls = 0;
    const cache = new QueryCache();
    const crud = makeCrud(
      {
        find: () => {
          driverCalls++;
          return { toArray: async () => [{ _id: "1" }] };
        },
        insertOne: async (doc: Document) => ({ insertedId: "2", ...doc }),
      },
      { cache, dedupeReads: true },
    );

    await crud.findMany("users", { email: "a@b.c" });
    await crud.insertOne("users", { email: "a@b.c" });
    await crud.findMany("users", { email: "a@b.c" });
    expect(driverCalls).toBe(2); // write invalidated the cached read
  });
});
