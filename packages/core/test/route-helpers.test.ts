/**
 * @fileoverview Route helpers — the UUID schema, the `{ ok: true }` body, and
 * the paged-list trio (read the query, build the envelope, describe its schema).
 *
 * Pins the behaviour apps depend on: garbage query values fall back instead of
 * throwing, `pageSize` is clamped, and the envelope's `pageCount` never drops
 * below 1 (an empty result still renders one empty page).
 */

import {
  OkResponse,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  pageResponse,
  pageSchema,
  readPagination,
  Uuid,
} from "@ignex/core/http";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

const search = (query: string) => new URLSearchParams(query);

describe("readPagination", () => {
  it("defaults to page 1 and the default page size", () => {
    expect(readPagination(search(""))).toEqual({
      page: 1,
      pageSize: PAGE_SIZE_DEFAULT,
      offset: 0,
      limit: PAGE_SIZE_DEFAULT,
    });
  });

  it("computes the offset for later pages", () => {
    const page = readPagination(search("page=3&pageSize=10"));
    expect(page).toMatchObject({ page: 3, pageSize: 10, offset: 20, limit: 10 });
  });

  it("clamps pageSize to the maximum", () => {
    expect(readPagination(search("pageSize=100000")).pageSize).toBe(PAGE_SIZE_MAX);
  });

  it("falls back instead of throwing on garbage", () => {
    expect(readPagination(search("page=abc&pageSize=-5"))).toMatchObject({
      page: 1,
      pageSize: PAGE_SIZE_DEFAULT,
      offset: 0,
    });
    expect(readPagination(search("page=2.5"))).toMatchObject({ page: 1 });
  });

  it("accepts a route context as well as raw search params", () => {
    const ctx = { url: new URL("https://example.test/rows?page=2&pageSize=5") };
    expect(readPagination(ctx)).toMatchObject({ page: 2, pageSize: 5, offset: 5 });
  });

  it("honours custom defaults and caps", () => {
    expect(readPagination(search(""), { defaultPageSize: 50, maxPageSize: 50 }).pageSize).toBe(50);
    expect(readPagination(search("pageSize=80"), { maxPageSize: 25 }).pageSize).toBe(25);
  });
});

describe("pageResponse", () => {
  it("wraps the rows with paging metadata", () => {
    expect(pageResponse([1, 2], readPagination(search("page=2&pageSize=2")), 5)).toEqual({
      items: [1, 2],
      page: 2,
      pageSize: 2,
      total: 5,
      pageCount: 3,
    });
  });

  it("never reports zero pages", () => {
    expect(pageResponse([], readPagination(search("")), 0).pageCount).toBe(1);
  });
});

describe("pageSchema", () => {
  it("describes the envelope the helper produces", () => {
    const schema = pageSchema(Type.Object({ id: Uuid }));
    expect(
      Value.Check(
        schema,
        pageResponse([{ id: crypto.randomUUID() }], readPagination(search("")), 1),
      ),
    ).toBe(true);
    expect(
      Value.Check(schema, {
        items: [{ id: "not-a-uuid" }],
        page: 1,
        pageSize: 20,
        total: 1,
        pageCount: 1,
      }),
    ).toBe(false);
    expect(Value.Check(schema, { items: [], page: 1 })).toBe(false);
  });
});

describe("Uuid / OkResponse", () => {
  it("validates UUID strings only", () => {
    expect(Value.Check(Uuid, crypto.randomUUID())).toBe(true);
    expect(Value.Check(Uuid, "1234")).toBe(false);
  });

  it("describes the acknowledgement body", () => {
    expect(Value.Check(OkResponse, { ok: true })).toBe(true);
    expect(Value.Check(OkResponse, { ok: false })).toBe(false);
  });
});
