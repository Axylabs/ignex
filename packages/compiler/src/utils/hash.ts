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

import { fnv1a64 } from "@ignex/native";

/**
 * FNV-1a 64-bit string hash via `@ignex/native` — the selection table
 * (`packages/native/src/selection.ts`) owns the impl choice (castrum native,
 * measured x6.74 on the 2026-08-11 bench), deterministic whether or not the
 * Rust addon is present. Used for cache fingerprints and content keys — cold
 * paths where speed pays off.
 */
export const hashString = (input: string): string => fnv1a64(input).toString(16);
