import type { Document, UpdateFilter } from "mongodb";
import type { UpdateInput } from "./update-types.ts";

/** True when `update` uses `$`-operator syntax (vs a plain field patch). */
export const hasUpdateOperator = (update?: UpdateFilter<Record<string, unknown>>): boolean => {
  if (!update) return false;
  return Object.keys(update).some((key) => key.startsWith("$"));
};

/**
 * Normalize an update payload: a plain object (e.g. `{ name: 'x' }`) becomes
 * `{ $set: { name: 'x' } }`; documents already using `$` operators pass through
 * unchanged. Used by `upsert` / `bulkUpsert`.
 */
export const formatUpdateFilter = <T extends Document>(update: UpdateInput<T>): UpdateFilter<T> => {
  if (hasUpdateOperator(update as UpdateFilter<Record<string, unknown>>)) {
    return update as UpdateFilter<T>;
  }
  return { $set: update } as UpdateFilter<T>;
};
