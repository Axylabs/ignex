/**
 * Hash utilities used by route analysis.
 *
 * Removed:
 * - canUseDenseArray
 * - generatePerfectHash
 * - segmentHash
 *
 * These belonged to the unused jump-table optimizer path.
 */

import { fnv1a64 } from "@flux/native";

export const fnv1a = (str: string): number => {
  let hash = 0x811c9dc5;

  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return hash >>> 0;
};

export const computeSignatureHash = (methodIdx: number, path: string): number => {
  const pathHash = fnv1a(path);
  return ((methodIdx & 0x07) << 29) | (pathHash >>> 3);
};

/**
 * FNV-1a 64-bit string hash, native-accelerated (~11x faster than the JS
 * loop) and deterministic whether or not the Rust addon is present. Used for
 * cache fingerprints and content keys — cold paths where speed pays off.
 */
export const hashString = (input: string): string => fnv1a64(input).toString(16);
