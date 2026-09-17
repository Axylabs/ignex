/** Shared castrum ingress transport; no duplicate ABI map or dlopen. */
import { realpathSync } from "node:fs";
import type { FfiIngressSurface } from "./ffi";
import { getAddonPath, isNativeAvailable, loadCastrumModule } from "./loader";
import { reportDegradation } from "./telemetry";

type SharedBinding = FfiIngressSurface & { readonly addonPath: string };

// Resolve once at module initialization, never on the synchronous request path.
const shared = await (async (): Promise<SharedBinding | null> => {
  if (!isNativeAvailable() || process.env.IGNEX_NATIVE === "off") return null;
  if (process.env.IGNEX_FFI_MODE === "napi") return null;
  try {
    const mod = await loadCastrumModule();
    if (typeof mod?.getIngressBinding !== "function") return null;
    const binding = (mod.getIngressBinding as () => SharedBinding | null)();
    const path = getAddonPath();
    // Never send an opaque pointer from one binary to another, including a
    // baseline/v3 fallback or an independently configured castrum override.
    if (!binding || !path) return null;
    if (realpathSync(binding.addonPath) !== realpathSync(path)) {
      reportDegradation("call-failed", "ingress.bind", "castrum/ignex addon paths differ");
      return null;
    }
    return binding;
  } catch (error) {
    reportDegradation("call-failed", "ingress.bind", String(error));
    return null;
  }
})();

/** Castrum's self-tested writers, or null when unavailable/disabled/mismatched. */
export const getSharedIngressBinding = (): FfiIngressSurface | null => shared;
