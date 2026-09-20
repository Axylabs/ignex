/**
 * @fileoverview Metrics registry shared internals — the default buckets, the
 * sorted-keys family identity and the native bucket sanitizer, used by both
 * the native-backed and pure-TS registries.
 *
 * Extracted from the pre-split `metrics.ts` (move-only); the two registry
 * implementations (`./registry-native`, `./registry-fallback`) import from
 * here so the helpers live in exactly one file each.
 */

/** Default histogram bucket upper-bounds (1 → 10_000, 13 buckets). */
export const DEFAULT_BUCKETS = [1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/** Sorted label keys — the stable (name, sorted-keys) family identity. */
export const sortedKeys = (labels: Record<string, string>): string[] => Object.keys(labels).sort();

/** Buckets must be finite, > 0 and ≤ 64 entries for the native engine. */
export const sanitizeBuckets = (b: readonly number[]): number[] => {
  const clean = [...b].filter((x) => Number.isFinite(x) && x > 0).sort((a, z) => a - z);
  const deduped = clean.filter((x, i) => i === 0 || x !== clean[i - 1]);
  return deduped.length > 0 ? deduped.slice(0, 64) : [1];
};
