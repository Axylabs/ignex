/**
 * Native addon loader.
 *
 * Loads the `castrum` NAPI addon once, lazily, and NEVER throws: when the
 * addon is missing (or fails to load) we fall back to the pure-TS
 * implementations, so flux works everywhere and native is purely an
 * acceleration layer.
 *
 * The resolved module can be overridden with `FLUX_NATIVE_PATH` (a module
 * specifier or absolute file path) for custom builds / testing.
 */
import type * as Castrum from "./vendor/castrum";

/** The typed surface of the loaded addon. */
export type NativeAddon = typeof Castrum;

let native: NativeAddon | null = null;

/** True when a module exposes the expected native function surface. */
const isNativeSurface = (mod: unknown): mod is NativeAddon => {
  const m = mod as Record<string, unknown>;
  return (
    typeof m === "object" &&
    m !== null &&
    typeof m.fnv1a64 === "function" &&
    typeof m.crc32 === "function" &&
    typeof m.jwtSign === "function"
  );
};

const init = (async (): Promise<void> => {
  const override = process.env.FLUX_NATIVE_PATH;
  try {
    const mod = override ? await import(override) : await import("castrum");
    // castrum ships two entry shapes:
    //   - napi loader (dist/index.js) → flat functions
    //   - TS entry (index.ts, Bun condition) → `rust` namespace
    // Normalize both, and reject empty/partial modules so we always fall back.
    const candidate = (mod as { rust?: unknown }).rust ?? mod;
    native = isNativeSurface(candidate) ? (candidate as NativeAddon) : null;
  } catch {
    native = null;
  }
})();

await init;

/** The loaded addon (or `null` when unavailable). */
export const getNative = (): NativeAddon | null => native;

/** True when the Rust addon is present and usable. */
export const isNativeAvailable = (): boolean => native != null;
