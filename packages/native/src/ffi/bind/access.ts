/**
 * @fileoverview Lazy singleton accessors for the C-ABI primary surface —
 * `bind()` orchestrates dlopen → surface build → bind-time self-test with
 * auto-mode fallback to NAPI; `isFfiActive()`/`getFfi()` are the public probes.
 *
 * Extracted from the pre-split `ffi/bind.ts` (move-only): the inlined dlopen
 * and surface construction moved to `./dlopen` and `./surface`, keeping the
 * callers' semantics byte-identical.
 */

import { getAddonPath } from "../../loader";
import { reportDegradation } from "../../telemetry";
import { isBun, resolveFfiMode } from "../helpers";
import { selfTest } from "../self-test";
import type { FfiSurface } from "../types";
import { dlopenSymbols } from "./dlopen";
import { buildSurface } from "./surface";

let cached: FfiSurface | null | undefined;

/** True when the C-ABI transport is live (bound + self-test passed). */
export const isFfiActive = (): boolean => getFfi() !== null;

let bound = false;
function bind(): FfiSurface | null {
  if (bound) return cached ?? null;
  bound = true;
  if (process.env.IGNEX_NATIVE === "off") return null;
  const mode = resolveFfiMode();
  if (!isBun() || mode === "napi") return null;

  const path = getAddonPath();
  if (!path) return null;

  try {
    // dlopen the scalar cores; `null` = bun:ffi not requireable (already
    // guarded by isBun() above), a failed dlopen call propagates to the catch.
    const symbols = dlopenSymbols(path);
    if (!symbols) return null;
    const surface = buildSurface(symbols);

    if (!selfTest(surface)) {
      if (mode === "ffi") {
        throw new Error(
          "IGNEX_FFI_MODE=ffi: the bun:ffi bind-time self-test failed — the C-ABI " +
            "transport cannot be trusted on this Bun/addon combination. Unset " +
            "IGNEX_FFI_MODE (or use auto) to fall back to NAPI.",
        );
      }
      // Auto mode: degrade to NAPI, but never silently — a host where bun:ffi
      // breaks (e.g. after a Bun upgrade) would otherwise permanently run
      // ~10-350ns/op slower with zero signal.
      reportDegradation(
        "self-test-failed",
        "ffi.bind",
        "bun:ffi bind-time self-test failed — C-ABI transport disabled, NAPI owns native ops",
      );
      return null;
    }
    cached = surface;
    return surface;
  } catch (err) {
    if (mode === "ffi") {
      // Explicit ffi requested and it failed — surface the failure loudly.
      const cause = err instanceof Error ? `: ${err.message}` : `: ${String(err)}`;
      throw new Error(`IGNEX_FFI_MODE=ffi: failed to bind bun:ffi${cause}`);
    }
    reportDegradation(
      "call-failed",
      "ffi.bind",
      `bun:ffi dlopen/bind failed — C-ABI transport disabled, NAPI owns native ops${
        err instanceof Error ? `: ${err.message}` : ""
      }`,
    );
    return null;
  }
}

/**
 * The C-ABI surface (`null` when unavailable — Node, forced napi, missing
 * addon, or a failed bind-time self-test). Cached; never throws in auto mode.
 */
export const getFfi = (): FfiSurface | null => {
  if (cached !== undefined) return cached;
  cached = bind();
  return cached;
};
