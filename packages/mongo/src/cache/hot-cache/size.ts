/**
 * Cheap, BSON-aware byte estimator used by the HotCache `maxValueBytes` guard.
 * It is deliberately approximate (strings 2 bytes/char, fixed sizes for
 * primitives/BSON kinds) — enough to reject pathologically large values without
 * the cost of a real BSON encoder.
 */
import { ObjectId } from "mongodb";

/** Approximate in-memory byte size of a cached value (used to bound single entries). */
export const estimateSize = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (value instanceof ObjectId) return 16;
  if (value instanceof Date) return 8;
  if (Array.isArray(value)) return value.reduce<number>((sum, v) => sum + estimateSize(v), 0);
  if (typeof value === "object") {
    let sum = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      sum += k.length * 2 + estimateSize(v);
    }
    return sum;
  }
  return 0;
};
