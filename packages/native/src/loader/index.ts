/**
 * @fileoverview Native addon loader — barrel re-exporting the public loader
 * surface (types + accessors + eager init) so existing `"./loader"` imports
 * resolve after the split of the pre-split `loader.ts` (move-only).
 *
 * Evaluation order matters and is preserved: `./native` runs its eager `init`
 * IIFE (with top-level await) before any consumer of this barrel reaches
 * `getNative`/`isNativeAvailable`, exactly like the monolith.
 */

export { initNative, loadCastrumModule } from "./init";
export { getAddonPath, getNative, isNativeAvailable } from "./native";
export type { NativeAddon, NativeInitOptions, NativeInitResult } from "./types";
