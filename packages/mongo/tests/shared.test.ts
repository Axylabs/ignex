import { describe, expect, test } from "bun:test";
import { BadRequest } from "../src/errors/index.ts";
import { mergeMongoFilters } from "../src/shared/merge-filters.ts";
import { normalizePageLimit } from "../src/shared/pagination-math.ts";
import { buildPaginationResult } from "../src/shared/pagination-result.ts";
import { buildMongoActiveFilter, mergeMongoActiveFilter } from "../src/shared/soft-delete.ts";
import { stripDocumentId } from "../src/shared/strip-primary-key.ts";

describe("normalizePageLimit", () => {
  test("applies defaults and computes offset", () => {
    expect(normalizePageLimit({}, 1000)).toEqual({ page: 1, limit: 10, offset: 0 });
    expect(normalizePageLimit({ page: 2, limit: 20 }, 1000)).toEqual({
      page: 2,
      limit: 20,
      offset: 20,
    });
  });

  test("floors page to >= 1", () => {
    expect(normalizePageLimit({ page: 0, limit: 5 }, 1000).page).toBe(1);
    expect(normalizePageLimit({ page: -3, limit: 5 }, 1000).page).toBe(1);
  });

  test("rejects limit out of range", () => {
    expect(() => normalizePageLimit({ limit: 0 }, 1000)).toThrow(BadRequest);
    expect(() => normalizePageLimit({ limit: 1001 }, 1000)).toThrow(BadRequest);
  });

  test("rejects NaN / Infinity page or limit", () => {
    expect(() => normalizePageLimit({ page: NaN, limit: 5 }, 1000)).toThrow(BadRequest);
    expect(() => normalizePageLimit({ page: Infinity, limit: 5 }, 1000)).toThrow(BadRequest);
    expect(() => normalizePageLimit({ page: 1, limit: NaN }, 1000)).toThrow(BadRequest);
    expect(() => normalizePageLimit({ page: 1, limit: Infinity }, 1000)).toThrow(BadRequest);
  });
});

describe("buildPaginationResult", () => {
  test("computes pages and hasNext/hasPrev", () => {
    const r = buildPaginationResult([1, 2], 25, 2, 10);
    expect(r.totalPages).toBe(3);
    expect(r.currentPage).toBe(2);
    expect(r.hasNextPage).toBe(true);
    expect(r.hasPrevPage).toBe(true);
    expect(r.totalCount).toBe(25);
  });
});

describe("soft-delete", () => {
  test("active filter matches missing or null deletedAt", () => {
    const f = buildMongoActiveFilter();
    expect(f.$or).toEqual([{ deletedAt: { $exists: false } }, { deletedAt: null }]);
  });

  test("merges with caller filter via $and", () => {
    const merged = mergeMongoActiveFilter(true, { email: "a@b.c" });
    expect(merged.$and).toHaveLength(2);
  });

  test("returns active filter alone when caller filter empty", () => {
    expect(mergeMongoActiveFilter(true, undefined)).toEqual(buildMongoActiveFilter());
  });

  test("passes through when softDelete false", () => {
    expect(mergeMongoActiveFilter(false, { x: 1 })).toEqual({ x: 1 });
  });
});

describe("stripDocumentId", () => {
  test("removes _id", () => {
    expect(stripDocumentId({ _id: "1", a: 2 })).toEqual({ a: 2 });
  });
});

describe("mergeMongoFilters", () => {
  test("skips empty parts, later keys win", () => {
    expect(mergeMongoFilters(undefined, { a: 1 }, { b: 2 }, { a: 3 })).toEqual({ a: 3, b: 2 });
  });
});
