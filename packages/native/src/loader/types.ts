/**
 * @fileoverview Public types of the native addon loader — the typed surface of
 * the loaded castrum addon and the `initNative` contract.
 *
 * Extracted from the pre-split `loader.ts` (move-only); re-exported by
 * `./index` (barrel) so the `"./loader"` imports keep resolving.
 */

import type * as Castrum from "../vendor/castrum";

/** The typed surface of the loaded addon. */
export type NativeAddon = typeof Castrum;

/** Options for {@link initNative}. */
export interface NativeInitOptions {
  /**
   * Rayon worker-pool size. Only honored before the pool's first use (castrum
   * initializes on first batch op). Defaults to `max(1, cpus - 1)`.
   */
  threads?: number;
}

/** Result of {@link initNative}. */
export interface NativeInitResult {
  /** Whether the Rust addon is present and usable. */
  readonly available: boolean;
  /** Current rayon worker count after init (0 when unavailable / not yet used). */
  readonly rayonThreads: number;
}
