/**
 * @fileoverview Eager native init + full-module loading — `initNative`
 * pre-warms the rayon pool at boot (idempotent, never throws) and
 * `loadCastrumModule` loads the full castrum TS entry for features that only
 * exist in the integration layer.
 *
 * Extracted from the pre-split `loader.ts` (move-only); the `native` state and
 * package-location ladder live in `./native` and `./paths`. The module's
 * `native` singleton is read through `getNative()` (identical value — a pure,
 * synchronous read of the same module state).
 */

import { pathToFileURL } from "node:url";
import { getNative } from "./native";
import { findCastrumDir, resolveCastrumEntryPath } from "./paths";
import { reportLoadFailure } from "./require";
import type { NativeInitOptions, NativeInitResult } from "./types";

let nativeInitialized = false;

/** Default rayon pool size: `max(1, hardwareConcurrency - 1)`. */
const defaultThreads = (): number => {
  const cpus =
    typeof navigator !== "undefined" && "hardwareConcurrency" in navigator
      ? navigator.hardwareConcurrency
      : 0;
  return Math.max(1, (cpus || 4) - 1);
};

/**
 * Eagerly initialize the Rust addon at boot — idempotent and NEVER throws.
 *
 * Pre-warms the rayon worker pool and forces the addon's initialization work
 * to happen during startup (load time) instead of lazily on the first request
 * (runtime). This is the explicit "sacrifice load time for runtime
 * performance" hook. Without the addon this is a harmless no-op.
 */
export const initNative = (options: NativeInitOptions = {}): NativeInitResult => {
  const native = getNative();
  if (!native) return { available: false, rayonThreads: 0 };
  try {
    if (!nativeInitialized) {
      nativeInitialized = true;
      const initPool = native.initThreadPool;
      if (typeof initPool === "function") {
        initPool(options.threads ?? defaultThreads());
      }
    }
    const count = native.rayonNumThreads;
    return { available: true, rayonThreads: typeof count === "function" ? count() : 0 };
  } catch {
    return { available: false, rayonThreads: 0 };
  }
};

/**
 * Load the full castrum module (TS entry) — needed for features that only
 * exist in the TS integration layer (e.g. `createPipeline`, the ingress
 * route-manager adapter). Resolved by absolute path to bypass the tsconfig
 * `paths` stub. Returns `null` when unavailable.
 */
export const loadCastrumModule = async (): Promise<Record<string, unknown> | null> => {
  const dir = findCastrumDir();
  const entry = dir ? resolveCastrumEntryPath(dir) : null;
  if (!entry) return null;
  try {
    const mod = await import(pathToFileURL(entry).href);
    return (
      (mod as { default?: Record<string, unknown> }).default ?? (mod as Record<string, unknown>)
    );
  } catch (err) {
    reportLoadFailure(err);
    return null;
  }
};
