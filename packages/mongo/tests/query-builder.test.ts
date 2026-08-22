import { describe, expect, test } from "bun:test";
import type { Document } from "mongodb";
import { QueryBuilder } from "../src/query-builder/query-builder.ts";

interface UserDoc extends Document {
  _id: unknown;
  email: string;
  role: string;
  createdAt: Date;
}

interface Capture {
  filter?: Document;
  options?: Record<string, unknown>;
  op?: string;
}

const makeBuilder = (capture: Capture) => {
  const collection = {
    find: (filter: Document, options: Record<string, unknown>) => {
      capture.filter = filter;
      capture.options = options;
      return { toArray: async (): Promise<UserDoc[]> => [] };
    },
    findOne: (filter: Document, options: Record<string, unknown>) => {
      capture.filter = filter;
      capture.options = options;
      return Promise.resolve(null);
    },
    countDocuments: (filter: Document, options: Record<string, unknown>) => {
      capture.filter = filter;
      capture.options = options;
      return Promise.resolve(0);
    },
  } as never;
  const ctx = {
    physicalName: "users",
    collection,
    run: async <T>(
      op: string,
      filter: unknown,
      execute: (opts: never) => Promise<T>,
      options: unknown,
    ): Promise<T> => {
      capture.op = op;
      void filter;
      void options;
      return execute(options as never);
    },
  } as never;
  return new QueryBuilder<UserDoc>(ctx);
};

describe("QueryBuilder", () => {
  test("compiles where + sort + limit into driver find options", async () => {
    const capture: Capture = {};
    const qb = makeBuilder(capture);
    await qb.where({ role: "admin" }).sort({ createdAt: -1 }).limit(5).many();
    expect(capture.filter).toEqual({ role: "admin" });
    expect(capture.options?.sort).toEqual({ createdAt: -1 });
    expect(capture.options?.limit).toBe(5);
  });

  test("select pushes a projection to the driver", async () => {
    const capture: Capture = {};
    const qb = makeBuilder(capture);
    await qb.where({ role: "admin" }).select(["email", "role"]).many();
    expect(capture.options?.projection).toEqual({ email: 1, role: 1 });
  });

  test("one() forces limit 1", async () => {
    const capture: Capture = {};
    const qb = makeBuilder(capture);
    await qb.where({ email: "a@b.c" }).one();
    expect(capture.op).toBe("mongo.getOne");
    expect(capture.options?.limit).toBe(1);
  });

  test("many() defaults limit to 100", async () => {
    const capture: Capture = {};
    const qb = makeBuilder(capture);
    await qb.where({}).many();
    expect(capture.options?.limit).toBe(100);
  });

  test("and() / or() compose filters", async () => {
    const capture: Capture = {};
    const qb = makeBuilder(capture);
    await qb.where({ role: "user" }).or({ age: 1 }, { age: 2 }).limit(10).many();
    expect(capture.filter?.$and).toHaveLength(2);
    expect(((capture.filter as Document).$and as Document[])[1]!.$or).toHaveLength(2);
  });
});
