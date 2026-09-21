/**
 * @fileoverview Ingress C-ABI surface accessor. The actual bind lives in
 * `ingress-binding.ts` (NAPI-first, FFI fallback), which imports only the
 * {@link FfiIngressSurface} TYPE from this tree — no runtime cycle.
 *
 * Extracted from the pre-split `ffi.ts` (move-only).
 */
import { getSharedIngressBinding } from "../ingress-binding";

/** Shared castrum ingress C-ABI surface (null when unavailable). */
export const getFfiIngress = getSharedIngressBinding;
