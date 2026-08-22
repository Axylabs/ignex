/**
 * Deterministic hashing utilities used for cache keys / in-flight dedup keys.
 * `stableStringify` produces an order-insensitive serialization so two logically
 * identical filters yield the same hash regardless of key insertion order.
 */

type Primitive = string | number | boolean | bigint | null | undefined;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const toPrimitive = (v: unknown): Primitive => {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return `date:${v.getTime()}`;
  if (typeof v === "object") {
    // Mongo driver ObjectId has toHexString(); RegExp serializes as a string.
    const anyV = v as { toHexString?: () => string; source?: string; flags?: string };
    if (typeof anyV.toHexString === "function") return `oid:${anyV.toHexString()}`;
    if (anyV instanceof RegExp) return `re:${anyV.source}/${anyV.flags}`;
  }
  return v as Primitive;
};

/**
 * Stable stringify: recursively sorts object keys, coerces Date/ObjectId/RegExp
 * into primitive markers. Result is deterministic for a given logical value.
 */
export const stableStringify = (value: unknown): string => {
  const visit = (v: unknown): Primitive | Record<string, unknown> | unknown[] => {
    if (Array.isArray(v)) return v.map(visit);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) out[key] = visit(v[key]);
      return out;
    }
    return toPrimitive(v);
  };
  return JSON.stringify(visit(value));
};

/** djb2 string hash → base-36 (fits comfortably in a double, no BigInt). */
export const hashString = (input: string): string => {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
};

/** Convenience: hash any value through a stable stringification. */
export const stableHash = (value: unknown): string => hashString(stableStringify(value));
