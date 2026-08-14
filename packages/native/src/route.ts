/**
 * @fileoverview Per-route native stack — the "higher-order factory → pre-baked
 * instance" seam.
 *
 * `createNativeRoute(plan)` compiles a route descriptor (see `route-wire.ts`)
 * into a `NativeRoute` instance that pre-bakes, at construction: which parts
 * to parse (query/cookies), the draft-07 schemas to validate (fast_schema /
 * jsonschema), the limits, and any scalar-op state. At request time
 * `run(frame)` does ONE native call into that pre-baked stack and decodes the
 * fixed-layout result — the per-op `toBytes` copies + buffer allocations of
 * the scalar wrappers (queryPairs x0.28, cookiePairs x0.105, validators
 * x0.007 per selection.json) collapse into a single packed frame + one
 * crossing.
 *
 * Like `createNativePipeline`, this NEVER throws and returns `null` when the
 * loaded castrum addon does not ship the route stack — it is a pure
 * acceleration layer; the existing JS prelude is the fallback (byte-parity
 * preserved).
 */

import { getFfiRoute } from "./ffi";
import { getNative } from "./loader";
import {
  encodeRouteDescriptor,
  type NativeRouteFrame,
  type NativeRoutePlan,
  type NativeRouteRunResult,
  packRouteFrameInto,
  packRouteFrameLength,
  readRouteFrameLengths,
  readRouteResult,
} from "./route-wire";
import { withScratch } from "./scratch";

// Re-export the wire types so `./route` is the single import for the per-route
// stack (the index barrel re-exports from here).
export type { NativeRouteFrame, NativeRoutePlan, NativeRouteRunResult } from "./route-wire";

/** A compiled, pre-baked per-route native stack. */
export interface NativeRoute {
  /**
   * Run the pre-baked stack once for a request frame and return the decoded
   * result (parsed query/cookie pairs + per-part validation verdicts). Safe
   * to call concurrently from any worker (the native instance owns a
   * per-thread arena).
   */
  run(frame: NativeRouteFrame): NativeRouteRunResult;
  /** Release the native instance's resources (route dropped / app shutdown). */
  destroy(): void;
}

/**
 * Internal native binding behind a `NativeRoute`: NAPI `Route` class or the
 * C-ABI `castrum_route_*` handle. Both write the result wire into a
 * caller-provided `out` buffer and return the bytes written (0 = too small /
 * error — the standard growExact convention).
 */
interface NativeRouteBinding {
  run(frame: Uint8Array, out: Uint8Array): number;
  destroy(): void;
}

/** Optional NAPI route surface (castrum `Route` class, like `Ingress`). */
interface NapiRouteModule {
  Route?: new (
    descriptor: Uint8Array,
  ) => {
    run(frame: Uint8Array, out: Uint8Array): number;
    destroy?(): void;
  };
}

/** Bind the C-ABI transport (preferred) when it ships the route surface. */
const bindFfiRoute = (descriptor: Uint8Array): NativeRouteBinding | null => {
  const ffi = getFfiRoute();
  if (!ffi) return null;
  const handle = ffi.routeCompile(descriptor);
  if (!handle) return null;
  return {
    run(frame, out) {
      return ffi.routeRun(handle, frame, out);
    },
    destroy() {
      ffi.routeDestroy(handle);
    },
  };
};

/** Bind the NAPI transport when the addon ships a `Route` class. */
const bindNapiRoute = (descriptor: Uint8Array): NativeRouteBinding | null => {
  const mod = getNative() as NapiRouteModule | null;
  if (!mod || typeof mod.Route !== "function") return null;
  let instance: { run(frame: Uint8Array, out: Uint8Array): number; destroy?(): void };
  try {
    instance = new mod.Route(descriptor);
  } catch {
    return null;
  }
  if (typeof instance.run !== "function") {
    try {
      instance.destroy?.();
    } catch {
      /* ignore */
    }
    return null;
  }
  return {
    run: (frame, out) => instance.run(frame, out),
    destroy: () => {
      try {
        instance.destroy?.();
      } catch {
        /* ignore */
      }
    },
  };
};

/**
 * Compile a route plan into a pre-baked native stack, or `null` when the
 * loaded castrum addon does not ship the route surface. Construction cost is
 * paid at boot (the explicit trade the framework accepts); the per-request
 * hot path is one pooled frame pack + one native call + one decode.
 */
export const createNativeRoute = (plan: NativeRoutePlan): NativeRoute | null => {
  const descriptor = encodeRouteDescriptor(plan);
  const binding = bindFfiRoute(descriptor) ?? bindNapiRoute(descriptor);
  if (!binding) return null;

  return {
    run(frame) {
      // Both the frame pack and the first result attempt are pooled — neither
      // the packed frame nor the raw result escapes this call
      // (`readRouteResult` decodes into fresh JS values: strings + pair
      // arrays). Frame length and the TIGHT initial result bound are computed
      // from the packed wire (no re-encoding): the addon's route writer uses
      // the needed-size convention (`w > out.length` = EXACT required size), so
      // the common case is ONE pooled call at ~4 bytes/input byte instead of
      // the old `len*9` worst-case scratch, and only the rare miss allocates
      // EXACTLY once and retries (no re-run loop, no 9× over-allocation).
      return withScratch(packRouteFrameLength(frame), (packed) => {
        packRouteFrameInto(packed, frame);
        const { qLen, cLen } = readRouteFrameLengths(packed);
        const initial = 8 + qLen * 4 + cLen * 4 + 16;
        return withScratch(initial, (out) => {
          const w = binding.run(packed, out);
          if (w === 0) throw new Error("native route run failed");
          if (w <= out.length) return readRouteResult(out.subarray(0, w));
          // Rare miss: grow EXACTLY to the reported size and retry once.
          const exact = new Uint8Array(w);
          const w2 = binding.run(packed, exact);
          if (w2 === 0) throw new Error("native route run failed");
          if (w2 > exact.length) throw new Error("native route run: unstable needed size");
          return readRouteResult(exact.subarray(0, w2));
        });
      });
    },
    destroy: () => binding.destroy(),
  };
};
