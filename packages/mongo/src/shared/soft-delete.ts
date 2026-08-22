import type { Document, Filter } from "mongodb";
import type { FilterInput } from "./filter-types.ts";

/**
 * Soft-delete support. A soft-deleted row is one where `deletedAt` exists and is
 * non-null. Mirrors sdk-db's `crud-shared/soft-delete.ts`.
 */
export const buildMongoActiveFilter = (): Filter<Document> =>
  ({ $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }] }) as Filter<Document>;

/**
 * Merge a caller filter with the soft-delete "active" filter.
 *  - softDelete=false → the caller filter unchanged
 *  - empty/absent filter → active filter alone
 *  - otherwise → `{ $and: [filter, active] }`
 */
export const mergeMongoActiveFilter = <T extends Document>(
  softDelete: boolean,
  filter?: FilterInput<T> | Filter<T>,
): Filter<T> => {
  if (!softDelete) return (filter ?? {}) as Filter<T>;
  const active = buildMongoActiveFilter() as Filter<T>;
  if (!filter || Object.keys(filter).length === 0) return active;
  return { $and: [filter, active] } as Filter<T>;
};
