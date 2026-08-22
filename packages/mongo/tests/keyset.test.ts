import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { BadRequest } from "../src/errors/index.ts";
import { buildKeysetFilter, decodeCursor, encodeCursor } from "../src/shared/keyset.ts";
import {
  closeService,
  type EnterpriseServiceContext,
  makeEnterpriseService,
  maybeDescribe,
  probe,
} from "./helpers.ts";

const available = await probe();
const maybe = maybeDescribe(available);

/* ------------------------- pure helper tests ------------------------- */

describe("keyset helpers (pure)", () => {
  test("buildKeysetFilter: single ascending key", () => {
    expect(buildKeysetFilter({ score: 1 }, [10], "after")).toEqual({
      $or: [{ score: { $gt: 10 } }],
    });
  });

  test("buildKeysetFilter: single descending key after", () => {
    expect(buildKeysetFilter({ score: -1 }, [10], "after")).toEqual({
      $or: [{ score: { $lt: 10 } }],
    });
  });

  test("buildKeysetFilter: before inverts the comparison", () => {
    expect(buildKeysetFilter({ score: 1 }, [10], "before")).toEqual({
      $or: [{ score: { $lt: 10 } }],
    });
    expect(buildKeysetFilter({ score: -1 }, [10], "before")).toEqual({
      $or: [{ score: { $gt: 10 } }],
    });
  });

  test("buildKeysetFilter: multi-key prefix-equality disjunction", () => {
    expect(buildKeysetFilter({ a: 1, b: -1 }, [1, 2], "after")).toEqual({
      $or: [{ a: { $gt: 1 } }, { a: 1, b: { $lt: 2 } }],
    });
  });

  test("cursor roundtrip preserves value types (ObjectId/Date/string/number/null/bool)", () => {
    const oid = new ObjectId();
    const date = new Date("2024-01-02T03:04:05.000Z");
    const cursor = encodeCursor({ sort: { _id: 1 }, values: [oid] });
    const decoded = decodeCursor(cursor);
    expect(decoded.sort).toEqual({ _id: 1 });
    expect(decoded.values[0]).toBeInstanceOf(ObjectId);
    expect((decoded.values[0] as ObjectId).toHexString()).toBe(oid.toHexString());

    const c2 = encodeCursor({
      sort: { at: 1 },
      values: [date, "x", 5, null, true],
    });
    const d2 = decodeCursor(c2);
    expect(d2.values[0]).toEqual(date);
    expect(d2.values[1]).toBe("x");
    expect(d2.values[2]).toBe(5);
    expect(d2.values[3]).toBeNull();
    expect(d2.values[4]).toBe(true);
  });

  test("decodeCursor throws on malformed payload", () => {
    expect(() => decodeCursor("not-valid-base64!!")).toThrow();
    const b64 = Buffer.from('{"nope":1}', "utf8").toString("base64url");
    expect(() => decodeCursor(b64)).toThrow();
  });
});

/* ----------------------- real MongoDB integration --------------------- */

maybe("keyset pagination (real MongoDB)", () => {
  let ctx!: EnterpriseServiceContext;
  let db!: EnterpriseServiceContext["db"];
  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_keyset_test");
    db = ctx.db;
  });
  afterAll(() => closeService(ctx));

  const sort = { placedAt: -1, _id: 1 } as Record<string, 1 | -1>;

  test("walks forward without gaps, overlaps, or missed docs", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let collected = 0;
    let hasMore = true;
    while (hasMore && pages < 100) {
      const page = await db.paginateCursor(
        "orders",
        {},
        {
          sort,
          limit: 4,
          after: cursor,
        },
      );
      for (const o of page.data) {
        expect(seen.has(String(o._id))).toBe(false);
        seen.add(String(o._id));
      }
      collected += page.data.length;
      pages++;
      hasMore = page.hasMore;
      cursor = page.nextCursor ?? undefined;
      if (!hasMore) expect(page.nextCursor).toBeNull();
    }
    const total = await db.countDocuments("orders", {});
    expect(collected).toBe(total);
    expect(seen.size).toBe(total);
    expect(pages).toBe(Math.ceil(total / 4));
  });

  test("before returns only docs strictly before the cursor", async () => {
    const first = await db.paginateCursor("orders", {}, { sort, limit: 4 });
    const last = first.data[first.data.length - 1] as {
      placedAt: Date;
      _id: { toHexString(): string };
    };
    const beforeCursor = encodeCursor({
      sort,
      values: Object.keys(sort).map((f) => (last as never as Record<string, unknown>)[f]),
    });
    const back = await db.paginateCursor("orders", {}, { sort, limit: 4, before: beforeCursor });
    expect(back.data.some((x) => String(x._id) === String(last._id))).toBe(false);
    for (const doc of back.data) {
      const d = doc as { placedAt: Date; _id: { toHexString(): string } };
      if (d.placedAt.getTime() !== last.placedAt.getTime()) {
        // descending placedAt: "before" means a LARGER placedAt
        expect(d.placedAt.getTime()).toBeGreaterThan(last.placedAt.getTime());
      } else {
        // ascending _id tiebreaker: "before" means a SMALLER _id
        expect(d._id.toHexString() < last._id.toHexString()).toBe(true);
      }
    }
  });

  test("rejects a cursor built with a different sort", async () => {
    const first = await db.paginateCursor("orders", {}, { sort, limit: 3 });
    if (first.nextCursor) {
      await expect(
        db.paginateCursor(
          "orders",
          {},
          {
            sort: { placedAt: 1, _id: 1 },
            limit: 3,
            after: first.nextCursor,
          },
        ),
      ).rejects.toThrow(/different sort/);
    }
  });

  test("rejects `before` and `after` together", async () => {
    const first = await db.paginateCursor("orders", {}, { sort, limit: 3 });
    const cursor = first.nextCursor ?? encodeCursor({ sort, values: [new Date(), 0] });
    await expect(
      db.paginateCursor("orders", {}, { sort, limit: 3, after: cursor, before: cursor }),
    ).rejects.toThrow(BadRequest);
  });

  test("rejects a cursor with mismatched value arity", async () => {
    const first = await db.paginateCursor("orders", {}, { sort, limit: 3 });
    if (first.nextCursor) {
      const decoded = decodeCursor(first.nextCursor);
      const shortCursor = encodeCursor({ sort: decoded.sort, values: decoded.values.slice(0, 1) });
      await expect(
        db.paginateCursor("orders", {}, { sort, limit: 3, after: shortCursor }),
      ).rejects.toThrow(/different sort/);
    }
  });
});
