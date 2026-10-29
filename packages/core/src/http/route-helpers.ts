/**
 * @fileoverview Route-level helpers for the boilerplate every JSON API repeats:
 * the UUID path schema, the `{ ok: true }` acknowledgement, and the paged list
 * (reading the query, the `{ items, page, … }` envelope, and its schema).
 *
 * Before, each list endpoint hand-rolled all three:
 *
 * ```ts
 * const search = ctx.url.searchParams;
 * const pagination = parsePagination({
 *   page: search.get("page") ? Number(search.get("page")) : undefined,
 *   pageSize: search.get("pageSize") ? Number(search.get("pageSize")) : undefined,
 * });
 * const response = Type.Object({
 *   items: Type.Array(itemSchema),
 *   page: Type.Integer(), pageSize: Type.Integer(),
 *   total: Type.Integer(), pageCount: Type.Integer(),
 * });
 * ```
 *
 * Now:
 *
 * ```ts
 * import { pageSchema, readPagination, pageResponse } from "@ignex/core/http";
 *
 * const response = pageSchema(itemSchema);
 * export default get(async (ctx) => {
 *   const page = readPagination(ctx);
 *   const { rows, total } = await listRows(page);
 *   return ctx.json(pageResponse(rows, page, total));
 * }, { response });
 * ```
 *
 * `readPagination` reads `ctx.url.searchParams` — not `ctx.query`, which is a
 * grouped object in a compiled build — so the same code works in dev and AOT.
 */

import { type Static, type TSchema, Type } from "typebox";

/**
 * A UUID string schema (`format: "uuid"`), for path params and ids.
 *
 * ```ts
 * const params = Type.Object({ id: Uuid });
 * ```
 */
export const Uuid = Type.String({ format: "uuid" });

/** The standard acknowledgement body: `{ ok: true }`. */
export const OkResponse = Type.Object({ ok: Type.Literal(true) });

/** Default page size when the request does not ask for one. */
export const PAGE_SIZE_DEFAULT = 20;
/** Upper bound on `pageSize`, so a client cannot ask for the whole table. */
export const PAGE_SIZE_MAX = 100;

/** A resolved page window: what a repository needs to `limit`/`offset`. */
export interface Pagination {
  /** 1-based page number. */
  page: number;
  /** Rows per page (clamped to {@link PAGE_SIZE_MAX}). */
  pageSize: number;
  /** `(page - 1) * pageSize`. */
  offset: number;
  /** Alias of {@link pageSize} for `limit(...)`. */
  limit: number;
}

/** Options for {@link readPagination}. */
export interface PaginationOptions {
  /** Page size when the request omits it (default {@link PAGE_SIZE_DEFAULT}). */
  defaultPageSize?: number;
  /** Upper bound for `pageSize` (default {@link PAGE_SIZE_MAX}). */
  maxPageSize?: number;
}

/** Either a route context or a raw query — both are accepted by {@link readPagination}. */
export type PageSource = { url: URL } | URLSearchParams;

/** Read a positive integer from the query, tolerating absent/garbage values. */
function readInt(
  search: URLSearchParams,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = search.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    return fallback;
  }
  return Math.min(value, max);
}

/**
 * Resolve `?page=` / `?pageSize=` into a {@link Pagination} window.
 *
 * Garbage (`?page=abc`, `?page=-2`, `?pageSize=1e9`) falls back to the default
 * or clamps instead of throwing: a list endpoint stays usable, and the query is
 * schema-validated separately when the shape matters.
 *
 * @param source - The route context (`{ url }`) or its `URLSearchParams`.
 * @param options - Default and maximum page size.
 * @returns The resolved page window.
 */
export function readPagination(source: PageSource, options: PaginationOptions = {}): Pagination {
  const search = source instanceof URLSearchParams ? source : source.url.searchParams;
  const maxPageSize = options.maxPageSize ?? PAGE_SIZE_MAX;
  const page = readInt(search, "page", 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = readInt(
    search,
    "pageSize",
    options.defaultPageSize ?? PAGE_SIZE_DEFAULT,
    1,
    maxPageSize,
  );
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

/** The paged list envelope {@link pageResponse} produces. */
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

/**
 * Wrap a page of rows in the standard list envelope.
 *
 * @param items - The rows for this page.
 * @param pagination - The window from {@link readPagination}.
 * @param total - Total rows matching the filter (not just this page).
 * @returns `{ items, page, pageSize, total, pageCount }`.
 */
export function pageResponse<T>(items: T[], pagination: Pagination, total: number): Page<T> {
  return {
    items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / pagination.pageSize)),
  };
}

/**
 * The response schema matching {@link pageResponse} — one line instead of the
 * five-field envelope repeated on every list route.
 *
 * @param item - The row schema.
 * @returns A TypeBox object schema `{ items: item[], page, pageSize, total, pageCount }`.
 */
export function pageSchema<T extends TSchema>(item: T) {
  return Type.Object({
    items: Type.Array(item),
    page: Type.Integer(),
    pageSize: Type.Integer(),
    total: Type.Integer(),
    pageCount: Type.Integer(),
  });
}

/** Static type of {@link pageSchema} for a given item schema. */
export type PageOf<T extends TSchema> = Static<ReturnType<typeof pageSchema<T>>>;
