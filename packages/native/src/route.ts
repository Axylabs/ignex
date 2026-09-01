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
  packRouteFramePartsInto,
  packRouteFramePartsLength,
  planHasStage,
  ROUTE_DESC_VERSION,
  readRouteFrameLengths,
  readRouteResult,
} from "./route-wire";
import { withScratch } from "./scratch";
import { reportDegradation } from "./telemetry";
import { encoder } from "./util";

// Re-export the wire types so `./route` is the single import for the per-route
// stack (the index barrel re-exports from here).
export type { NativeRouteFrame, NativeRoutePlan, NativeRouteRunResult } from "./route-wire";

let warnedRouteSurfaceAbsent = false;
/**
 * Warn ONCE when the per-route stack is unavailable despite native being
 * loaded. Routed through the telemetry sink (was a bare console.warn). Two
 * DISTINCT causes with different remediations:
 * - "surface absent": the addon build predates `castrum_route_*` (registry
 *   0.9.0 removed it; it returned in 0.10.0+) → upgrade castrum.
 * - "compile rejected": symbols exist but `castrum_route_compile` refused the
 *   descriptor → almost always a ROUTE_DESC_VERSION skew between this build's
 *   wire format and the installed addon (mismatched magic/version) → align
 *   @ignex/native and castrum versions; do NOT just upgrade blindly.
 */
function warnRouteSurfaceAbsent(reason: "surface-absent" | "compile-rejected"): void {
  if (warnedRouteSurfaceAbsent || getNative() === null) return;
  warnedRouteSurfaceAbsent = true;
  const detail =
    reason === "compile-rejected"
      ? "the addon EXPORTS castrum_route_* but rejected the route descriptor at compile — " +
        `a ROUTE_DESC_VERSION/magic skew between @ignex/native (v${ROUTE_DESC_VERSION}) and the ` +
        "installed castrum build. Align the two versions."
      : "the loaded addon does NOT ship the per-route native stack (castrum_route_*). " +
        "createNativeRoute() falls back to the JS prelude — ensure castrum >= 0.10.0 " +
        "(registry 0.9.0 removed the surface).";
  reportDegradation(
    reason === "compile-rejected" ? "unsupported" : "surface-missing",
    "route.compile",
    `${detail} JS prelude owns these routes.`,
  );
}

/** A compiled, pre-baked per-route native stack. */
export interface NativeRoute {
  /** Whether the plan compiled `parseQuery` (the result carries a query section). */
  readonly parseQuery: boolean;
  /** Whether the plan compiled `parseCookies` (the result carries a cookie section). */
  readonly parseCookies: boolean;
  /**
   * Run the pre-baked stack once for a request frame and return the decoded
   * result (parsed query/cookie pairs + per-part validation verdicts). Safe
   * to call concurrently from any worker (the native instance owns a
   * per-thread arena).
   */
  run(frame: NativeRouteFrame): NativeRouteRunResult;
  /**
   * Convenience (synced from castrum's `native-route.ts` `run(query, cookie,
   * body)` shape): run the stack from raw request inputs, packing the frame
   * from pre-encoded bytes — no per-request frame object on the compiled
   * handlers' hot path.
   */
  runParts(query: string, cookie: string, body: Uint8Array | null): NativeRouteRunResult;
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

/** Why a binding attempt produced no usable route stack. */
type BindFailureReason = "surface-absent" | "compile-rejected";

/** Bind the C-ABI transport (preferred) when it ships the route surface. */
const bindFfiRoute = (
  descriptor: Uint8Array,
  onFail: (reason: BindFailureReason) => void,
): NativeRouteBinding | null => {
  const ffi = getFfiRoute();
  // No C-ABI surface → fall through to NAPI without diagnosing yet (NAPI may
  // still own the Route class).
  if (!ffi) return null;
  const handle = ffi.routeCompile(descriptor);
  if (!handle) {
    // Symbols EXIST but the descriptor was refused — a wire-format skew, not a
    // missing surface. Diagnose precisely instead of blaming the build.
    onFail("compile-rejected");
    return null;
  }
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
const bindNapiRoute = (
  descriptor: Uint8Array,
  onFail: (reason: BindFailureReason) => void,
): NativeRouteBinding | null => {
  const mod = getNative() as NapiRouteModule | null;
  if (!mod || typeof mod.Route !== "function") return null;
  let instance: { run(frame: Uint8Array, out: Uint8Array): number; destroy?(): void };
  try {
    instance = new mod.Route(descriptor);
  } catch {
    onFail("compile-rejected");
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
  let failReason: BindFailureReason = "surface-absent";
  const onFail = (reason: BindFailureReason): void => {
    // First diagnostic wins (compile-rejected is the more specific signal).
    if (failReason === "surface-absent") failReason = reason;
  };
  const binding = bindFfiRoute(descriptor, onFail) ?? bindNapiRoute(descriptor, onFail);
  if (!binding) {
    // The route stack is OPTIONAL (JS prelude is the byte-parity fallback), but
    // a loaded addon WITHOUT a working surface is a silent regression the
    // framework should not hide — warn ONCE with the precise cause.
    warnRouteSurfaceAbsent(failReason);
    return null;
  }

  // The result wire carries a pair section ONLY for the parse stages in the
  // plan (body-only routes are a bare 8-byte header). Decode exactly the
  // sections present so readRouteResult never walks past the wire.
  const hasQuerySection = planHasStage(plan, "parseQuery");
  const hasCookieSection = planHasStage(plan, "parseCookies");

  // Single pack→run→decode core over PRE-ENCODED query/cookie bytes: the
  // compiled handlers' hot path encodes once and reuses the bytes for both
  // the frame-size computation and the pack (no double walk, no frame object).
  const runPacked = (
    query: Uint8Array,
    cookie: Uint8Array,
    body: Uint8Array | null,
  ): NativeRouteRunResult =>
    withScratch(packRouteFramePartsLength(query, cookie, body), (packed) => {
      packRouteFramePartsInto(packed, query, cookie, body);
      // Both the frame pack and the first result attempt are pooled — neither
      // the packed frame nor the raw result escapes this call
      // (`readRouteResult` decodes into fresh JS values: strings + pair
      // arrays). The TIGHT initial result bound is computed from the packed
      // wire (no re-encoding): the addon's route writer uses the needed-size
      // convention (`w > out.length` = EXACT required size), so the common
      // case is ONE pooled call at ~4 bytes/input byte instead of the old
      // `len*9` worst-case scratch, and only the rare miss allocates EXACTLY
      // once and retries (no re-run loop, no 9× over-allocation).
      const { qLen, cLen } = readRouteFrameLengths(packed);
      const initial = 8 + qLen * 4 + cLen * 4 + 16;
      return withScratch(initial, (out) => {
        const w = binding.run(packed, out);
        if (w === 0) throw new Error("native route run failed");
        if (w <= out.length) {
          return readRouteResult(out.subarray(0, w), {
            query: hasQuerySection,
            cookie: hasCookieSection,
          });
        }
        // Rare miss: grow EXACTLY to the reported size and retry once.
        const exact = new Uint8Array(w);
        const w2 = binding.run(packed, exact);
        if (w2 === 0) throw new Error("native route run failed");
        if (w2 > exact.length) throw new Error("native route run: unstable needed size");
        return readRouteResult(exact.subarray(0, w2), {
          query: hasQuerySection,
          cookie: hasCookieSection,
        });
      });
    });

  return {
    parseQuery: hasQuerySection,
    parseCookies: hasCookieSection,
    run(frame) {
      const q = encoder.encode(frame.query);
      const c = encoder.encode(frame.cookie);
      return runPacked(q, c, frame.body);
    },
    runParts(query, cookie, body) {
      const q = encoder.encode(query);
      const c = encoder.encode(cookie);
      return runPacked(q, c, body);
    },
    destroy: () => binding.destroy(),
  };
};
