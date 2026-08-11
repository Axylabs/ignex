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

/**
 * FNV-1a 64-bit string hash, native-accelerated (~11x faster than the JS
 * loop) and deterministic whether or not the Rust addon is present. Used for
 * cache fingerprints and content keys — cold paths where speed pays off.
 */
export const hashString = (input: string): string => fnv1a64(input).toString(16);
