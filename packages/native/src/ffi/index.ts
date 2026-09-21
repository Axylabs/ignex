/**
 * @fileoverview Public barrel for the ffi C-ABI surface tree — re-exports the
 * pre-split `ffi.ts` public names so `"./ffi"` resolves identically for
 * existing importers. `FfiInstancesSurface` is intentionally NOT re-exported
 * here: no in-repo consumer reaches it through the barrel (its only usage is
 * `instances.ts` via `./types`), and knip flags exactly this one as dead.
 */
export { getFfi, isFfiActive } from "./bind";
export { growExact } from "./helpers";
export { getFfiIngress } from "./ingress";
export { getFfiInstances } from "./instances";
export { getFfiMetrics } from "./metrics";
export { getFfiRoute } from "./routes";
export type {
  FfiIngressSurface,
  FfiMetricsSurface,
  FfiMode,
  FfiRouteSurface,
  FfiSurface,
} from "./types";
