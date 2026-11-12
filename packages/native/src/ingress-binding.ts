/** Shared castrum ingress transport backed by the configured native bridge. */
import type { FfiIngressSurface } from "./ffi";
import { getNativeBridge } from "./loader";

let cached: FfiIngressSurface | null | undefined;

/** Castrum's self-tested writers, or null when unavailable/disabled. */
export const getSharedIngressBinding = (): FfiIngressSurface | null => {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.env.IGNEX_NATIVE === "off") return cached;
  const ffi = getNativeBridge()?.getFfi();
  if (!ffi) return cached;
  cached = {
    ingressHandleComponents: ffi.ingressHandleComponents,
    ingressHandlePacked: ffi.ingressHandlePacked,
    ingressLayout: ffi.ingressLayout,
  };
  return cached;
};
