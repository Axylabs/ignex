/**
 * @fileoverview Lazy access to castrum's configured C-ABI bridge. Castrum
 * performs the bind and self-test; this module preserves Ignex's disable and
 * forced-transport behavior.
 */

import { getNativeBridge } from "../../loader";
import { resolveFfiMode } from "../helpers";
import type { FfiSurface } from "../types";
import { buildSurface } from "./surface";

let cached: FfiSurface | null | undefined;

/** True when the C-ABI transport is live (bound + self-test passed). */
export const isFfiActive = (): boolean => getFfi() !== null;

/**
 * The C-ABI surface (`null` when unavailable). Cached; never throws in auto
 * mode. Forced FFI failures retain their explicit error contract.
 */
export const getFfi = (): FfiSurface | null => {
  if (cached !== undefined) return cached;
  if (process.env.IGNEX_NATIVE === "off") {
    cached = null;
    return cached;
  }

  const bridge = getNativeBridge();
  if (!bridge) {
    cached = null;
    return cached;
  }

  const ffi = bridge.getFfi();
  if (bridge.ffiError && resolveFfiMode() === "ffi") {
    throw new Error(`IGNEX_FFI_MODE=ffi: ${bridge.ffiError.message}`);
  }
  if (!ffi) {
    cached = null;
    return cached;
  }

  cached = buildSurface(ffi);
  return cached;
};
