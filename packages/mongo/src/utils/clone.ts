import { ObjectId } from "mongodb";

/**
 * Deep-clone a value while preserving the BSON-ish types that
 * `JSON.parse(JSON.stringify())` would corrupt: `Date`, `ObjectId`, and
 * `RegExp`. Arrays and plain objects are copied recursively; primitives pass
 * through by reference. Used by the optional `clone` mode on `QueryCache` /
 * `HotCache` so a caller can't mutate a cached result and poison the shared
 * cache.
 */
export const cloneDeep = <T>(value: T): T => {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof ObjectId) return new ObjectId(value.toHexString()) as T;
  if (value instanceof RegExp) return new RegExp(value.source, value.flags) as T;
  if (Array.isArray(value)) return value.map((item) => cloneDeep(item)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = cloneDeep(v);
    }
    return out as T;
  }
  return value;
};
