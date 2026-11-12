/**
 * @fileoverview Per-route C-ABI adapter over castrum's shared native bridge.
 * The route handle remains bigint at Ignex's API boundary; castrum owns the
 * runtime-specific number/pointer representation.
 */

import { getNativeBridge } from "../loader";
import type { FfiRouteSurface } from "./types";

let cached: FfiRouteSurface | null | undefined;

/** Lazy access to the per-route C-ABI surface (`null` when unavailable). */
export const getFfiRoute = (): FfiRouteSurface | null => {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.env.IGNEX_NATIVE === "off") return cached;

  const ffi = getNativeBridge()?.getFfi();
  if (!ffi) return cached;
  cached = {
    routeCompile: (descriptor) => BigInt(ffi.routeCompile(descriptor)),
    routeRun: (handle, frame, out) => ffi.routeRun(Number(handle), frame, out),
    ...(typeof ffi.routeRunParts === "function"
      ? {
          routeRunParts: (
            handle: bigint,
            query: string,
            cookie: string,
            body: Uint8Array | null,
            out: Uint8Array,
          ) => ffi.routeRunParts(Number(handle), query, cookie, body, out),
        }
      : {}),
    routeDestroy: (handle) => ffi.routeDestroy(Number(handle)),
  };
  return cached;
};
