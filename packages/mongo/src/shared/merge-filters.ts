import type { Document, Filter } from "mongodb";

/**
 * Merge multiple Mongo filters into one. Empty/undefined parts are skipped and
 * later keys win on shallow conflicts (mirrors sdk-db `mergeMongoFilters`).
 */
export const mergeMongoFilters = <T extends Document>(
  ...parts: Array<Filter<T> | undefined>
): Filter<T> => {
  const out: Filter<T> = {};
  for (const part of parts) {
    if (!part) continue;
    Object.assign(out, part);
  }
  return out;
};
