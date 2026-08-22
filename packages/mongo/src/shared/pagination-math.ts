import { BadRequest } from "../errors/index.ts";

export interface CrudListQuery {
  page?: number;
  limit?: number;
}

export interface NormalizedPagination {
  page: number;
  limit: number;
  offset: number;
}

/**
 * Normalize + validate page/limit. Pure — no DB knowledge.
 *  - `page` is floored to >= 1
 *  - `limit` must be within [1, maxLimit] or a `BadRequest` is thrown
 */
export const normalizePageLimit = (
  query: CrudListQuery,
  maxLimit: number,
  defaults: { page?: number; limit?: number } = {},
): NormalizedPagination => {
  const rawPage = query.page ?? defaults.page ?? 1;
  const limit = query.limit ?? defaults.limit ?? 10;

  // Reject NaN / Infinity / non-numbers up front — `Math.floor(NaN)` would
  // otherwise flow into `$skip: NaN` as an obscure driver error.
  if (typeof rawPage !== "number" || !Number.isFinite(rawPage)) {
    throw new BadRequest("page must be a finite number");
  }
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new BadRequest("limit must be a finite number");
  }
  if (limit < 1) throw new BadRequest("limit must be >= 1");
  if (limit > maxLimit) throw new BadRequest(`limit ${limit} exceeds maxLimit ${maxLimit}`);

  const page = Math.max(1, Math.floor(rawPage));
  return { page, limit, offset: (page - 1) * limit };
};
