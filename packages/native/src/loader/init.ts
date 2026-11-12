/**
 * @fileoverview Eager native init and full-module loading. `initNative`
 * pre-warms the rayon pool at boot; `loadCastrumModule` loads castrum's
 * framework-neutral integration API through its package export.
 */

import { getNative, resolveNativeModuleUrl } from "./native";
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
 * Initialization work happens at startup instead of on the first request.
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

/** Load castrum's public integration module, or `null` when unavailable. */
export const loadCastrumModule = async (): Promise<Record<string, unknown> | null> => {
  let mod: unknown;
  try {
    mod = await import("@ignex/castrum");
  } catch (directError) {
    try {
      mod = await import(resolveNativeModuleUrl(""));
    } catch {
      reportLoadFailure(directError);
      return null;
    }
  }
  return (mod as { default?: Record<string, unknown> }).default ?? (mod as Record<string, unknown>);
};
