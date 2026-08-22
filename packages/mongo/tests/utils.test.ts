import { describe, expect, test } from "bun:test";
import {
  BadRequest,
  DomainError,
  httpStatusForError,
  InfraError,
  mapMongoDriverError,
  serializeError,
} from "../src/errors/index.ts";
import { withRetry } from "../src/mongo-helpers.ts";
import { defineCrudOp } from "../src/service/crud-op.ts";
import type { DbOpMeta } from "../src/service/trace-db-op.ts";
import { formatUpdateFilter, hasUpdateOperator } from "../src/service/update-format.ts";
import { stableHash, stableStringify } from "../src/utils/hash.ts";
import { LRU } from "../src/utils/lru.ts";
import { createCachedAsyncFactory, createCachedFactory } from "../src/utils/memoize.ts";

describe("LRU", () => {
  test("evicts least-recently-used", () => {
    const lru = new LRU<number, string>({ max: 2 });
    lru.set(1, "a");
    lru.set(2, "b");
    lru.get(1); // refresh recency of 1
    lru.set(3, "c"); // evicts 2
    expect(lru.get(1)).toBe("a");
    expect(lru.get(2)).toBeUndefined();
    expect(lru.get(3)).toBe("c");
  });
});

describe("cached factories", () => {
  test("sync factory caches by key", () => {
    let calls = 0;
    const f = createCachedFactory((k: string) => {
      calls++;
      return k.toUpperCase();
    });
    expect(f("a")).toBe("A");
    expect(f("a")).toBe("A");
    expect(calls).toBe(1);
  });

  test("async factory dedupes in-flight calls", async () => {
    let calls = 0;
    let resolveFirst!: (v: string) => void;
    const f = createCachedAsyncFactory((_k: string) => {
      calls++;
      return new Promise<string>((resolve) => {
        resolveFirst = resolve;
      });
    });
    const p1 = f("x");
    const p2 = f("x");
    expect(calls).toBe(1);
    resolveFirst("done");
    expect(await p1).toBe("done");
    expect(await p2).toBe("done");
  });

  test("async factory does NOT cache a failure — the next call retries", async () => {
    let calls = 0;
    const f = createCachedAsyncFactory(async (k: string) => {
      calls++;
      if (calls <= 2) throw new Error("boom");
      return `ok:${k}`;
    });
    await expect(f("x")).rejects.toThrow("boom");
    await expect(f("x")).rejects.toThrow("boom"); // failure evicted → second call retries
    expect(await f("x")).toBe("ok:x"); // third call succeeds
    expect(calls).toBe(3);
  });
});

describe("withRetry", () => {
  test("maxAttempts: 0 never surfaces `throw undefined`", async () => {
    const fn = async () => {
      throw new Error("boom");
    };
    await expect(withRetry(fn, { maxAttempts: 0 })).rejects.toThrow("boom");
  });

  test("retries only transient errors up to maxAttempts", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw { name: "MongoNetworkError", message: "x" };
      return "ok";
    };
    expect(await withRetry(fn, { maxAttempts: 3 })).toBe("ok");
    expect(calls).toBe(3);
  });

  test("does not retry non-transient errors", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error("boom");
    };
    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
});

describe("stable hashing", () => {
  test("is key-order independent", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableHash({ role: "admin", limit: 5 })).toBe(stableHash({ limit: 5, role: "admin" }));
  });
});

describe("update formatting", () => {
  test("detects $ operators", () => {
    expect(hasUpdateOperator({ $set: { a: 1 } })).toBe(true);
    expect(hasUpdateOperator({ a: 1 })).toBe(false);
  });

  test("wraps plain objects in $set", () => {
    expect(formatUpdateFilter({ a: 1 })).toEqual({ $set: { a: 1 } });
    expect(formatUpdateFilter({ $inc: { a: 1 } })).toEqual({ $inc: { a: 1 } });
  });
});

describe("error mapping", () => {
  test("maps duplicate key", () => {
    const mapped = mapMongoDriverError({ code: 11000, keyPattern: { email: 1 } }) as DomainError;
    expect(mapped).toBeInstanceOf(DomainError);
    expect(mapped.code).toBe("DUPLICATE_KEY");
    expect(mapped.extra?.keyPattern).toEqual({ email: 1 });
  });

  test("maps timeout", () => {
    const mapped = mapMongoDriverError({ code: 50 }) as InfraError;
    expect(mapped).toBeInstanceOf(InfraError);
    expect(mapped.code).toBe("MONGO_TIMEOUT");
  });

  test("maps validation failure", () => {
    expect((mapMongoDriverError({ code: 121 }) as DomainError).code).toBe("VALIDATION_FAILED");
  });

  test("passes through AppError", () => {
    const err = new DomainError("NOT_FOUND", "x");
    expect(mapMongoDriverError(err)).toBe(err);
  });

  test("statusCode is refined per code (404/409/422/504)", () => {
    expect(new DomainError("NOT_FOUND", "x").statusCode).toBe(404);
    expect(new DomainError("DUPLICATE_KEY", "x").statusCode).toBe(409);
    expect(new DomainError("VALIDATION_FAILED", "x").statusCode).toBe(422);
    expect(new DomainError("VERSION_CONFLICT", "x").statusCode).toBe(409);
    expect(new DomainError("COLLECTION_EXISTS", "x").statusCode).toBe(409);
    expect(new InfraError("MONGO_TIMEOUT", "x").statusCode).toBe(504);
    expect(new DomainError("SOME_OTHER_CODE", "x").statusCode).toBe(400);
    expect(new InfraError("SOME_OTHER_CODE", "x").statusCode).toBe(500);
  });

  test("toJSON produces a stable, stack-free payload", () => {
    const err = new DomainError("NOT_FOUND", "not here", { collection: "users" });
    expect(err.toJSON()).toEqual({
      name: "DomainError",
      code: "NOT_FOUND",
      message: "not here",
      statusCode: 404,
      extra: { collection: "users" },
    });
    const parsed = JSON.parse(JSON.stringify(err));
    expect(parsed).toEqual({
      name: "DomainError",
      code: "NOT_FOUND",
      message: "not here",
      statusCode: 404,
      extra: { collection: "users" },
    });
    expect("stack" in parsed).toBe(false);
  });

  test("httpStatusForError handles AppError + raw driver errors", () => {
    expect(httpStatusForError(new DomainError("VALIDATION_FAILED", "x"))).toBe(422);
    expect(httpStatusForError(new DomainError("NOT_FOUND", "x"))).toBe(404);
    expect(httpStatusForError({ code: 11000 })).toBe(500); // non-transient raw → 500
    expect(httpStatusForError({ name: "MongoNetworkError" })).toBe(503); // transient raw → 503
  });

  test("serializeError maps raw driver errors to a client-safe payload", () => {
    expect(serializeError({ code: 11000, keyValue: { email: "a@b.c" } })).toEqual({
      name: "DomainError",
      code: "DUPLICATE_KEY",
      message: "Duplicate key error",
      statusCode: 409,
      extra: { keyValue: { email: "a@b.c" } },
    });
    expect(serializeError(new BadRequest("bad input"), { op: "x" })).toMatchObject({
      name: "BadRequest",
      code: "BAD_REQUEST",
      statusCode: 400,
    });
  });
});

describe("defineCrudOp (write-retry gating)", () => {
  const deps = {
    trace: async <T>(_meta: DbOpMeta, fn: () => T | Promise<T>): Promise<T> => fn(),
    meta: (_collection: string, op: string): DbOpMeta => ({
      collection: "x",
      physicalCollection: "x",
      db: "d",
      op,
    }),
  };
  const transient = () => {
    throw { name: "MongoNetworkError", message: "x" };
  };

  test("writes do NOT retry transient errors by default (at-least-once guard)", async () => {
    let calls = 0;
    const execute = async () => {
      calls++;
      transient();
    };
    await expect(
      defineCrudOp(deps, "users", "mongo.insertOne", execute, undefined, true),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  test("writes retry transient errors when retryWrites: true", async () => {
    let calls = 0;
    const execute = async () => {
      calls++;
      if (calls < 3) transient();
      return "ok";
    };
    const result = await defineCrudOp(
      deps,
      "users",
      "mongo.insertOne",
      execute,
      { retryWrites: true },
      true,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("reads retry transient errors by default", async () => {
    let calls = 0;
    const execute = async () => {
      calls++;
      if (calls < 2) transient();
      return "ok";
    };
    const result = await defineCrudOp(deps, "users", "mongo.getOne", execute, undefined, false);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});
