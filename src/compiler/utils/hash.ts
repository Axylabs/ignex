/**
 * @fileoverview Hash Utilities
 * Pure functions for FNV-1a, signature hashing, segment hashing, and
 * perfect hash generation. No side effects. No mutations.
 */

/** FNV-1a 32-bit hash. Pure. */
export const fnv1a = (str: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
};

/**
 * Combine method index (3 bits) + path hash (29 bits) into single u32.
 * Method indices: GET=0, POST=1, PUT=2, PATCH=3, DELETE=4, HEAD=5, OPTIONS=6, ALL=7
 */
export const computeSignatureHash = (methodIdx: number, path: string): number => {
  const pathHash = fnv1a(path);
  return ((methodIdx & 0x07) << 29) | (pathHash >>> 3);
};

/** DJB2-style segment hash for trie node comparison. Pure. */
export const segmentHash = (seg: string): number => {
  let h = 5381;
  for (let i = 0; i < seg.length; i++) {
    h = ((h << 5) + h) + seg.charCodeAt(i); // h * 33 + c
    h |= 0;
  }
  return h >>> 0;
};

/**
 * Check if a set of hashes can use a dense array strategy.
 * Dense is viable when hash range < 3x count (space vs time tradeoff).
 */
export const canUseDenseArray = (hashes: readonly number[]): boolean => {
  if (hashes.length === 0) return false;
  const min = Math.min(...hashes);
  const max = Math.max(...hashes);
  return (max - min) < hashes.length * 3;
};

/**
 * Generate a perfect hash function for small static sets (≤100 items).
 * Uses brute-force seed search. Returns null if no seed found.
 * Pure — no mutation of input.
 */
export const generatePerfectHash = (
  hashes: readonly number[]
): { readonly g: readonly number[]; readonly v: readonly number[] } | null => {
  if (hashes.length === 0 || hashes.length > 100) return null;
  const n = hashes.length;
  const seen = new Set<number>();
  for (const h of hashes) {
    if (seen.has(h)) return null; // collisions in input make perfect hash impossible
    seen.add(h);
  }

  for (let seed = 0; seed < 1000; seed++) {
    const buckets = new Map<number, number>();
    let ok = true;
    for (let i = 0; i < n; i++) {
      const idx = ((hashes[i]! + seed) % n + n) % n;
      if (buckets.has(idx)) { ok = false; break; }
      buckets.set(idx, i);
    }
    if (ok) return { g: [seed], v: hashes };
  }
  return null;
};