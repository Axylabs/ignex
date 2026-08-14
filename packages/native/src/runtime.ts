/**
 * Runtime execution seam — the ONLY module that combines addon availability
 * with the selection table. Wrappers ask `useNative(op)` instead of checking
 * `getNative()` themselves, so "is native loaded" and "does native win for
 * this op" are answered in one place, from the single source of truth in
 * `./selection.ts`.
 */

import { getFfi } from "./ffi";
import type { NativeAddon } from "./loader";
import { getNative } from "./loader";
import { type ExecutionBackend, OPS, type OpName, SELECTION } from "./selection";

/** The loaded castrum addon (or `null` when unavailable). Resolved once at import. */
export const native = getNative();

/** The C-ABI (`bun:ffi`) surface when it is bound + self-tested (or `null`). */
export const ffi = getFfi();

/**
 * A single handle that prefers the C-ABI binding for the ops it covers and
 * falls through to the NAPI addon for everything else (stateful classes,
 * `opImpl`, thread-pool init, …). Wrappers keep calling `n.op(...)` unchanged.
 */
const preferred: NativeAddon | null =
  native != null && ffi != null
    ? new Proxy(native, {
        get(target, prop, receiver) {
          const f = (ffi as unknown as Record<PropertyKey, unknown>)[prop];
          if (typeof f === "function") return f;
          return Reflect.get(target, prop, receiver);
        },
      })
    : native;

/**
 * Ops where the C-ABI (`bun:ffi`) transport is PROVEN faster than the JS
 * fallback by median benchmark (`scripts/bench-ffi.ts`), overriding the
 * NAPI-based castrum selection (which measured these as JS wins because the
 * ~300ns NAPI crossing swamped the gain). Under the ~10-20ns C-ABI crossing
 * they win (median of repeated runs): etag ~1.13x, validateIpv6 ~1.99x,
 * hmacSha256 ~1.49x (vs Bun.CryptoHasher), randomToken ~1.33x (vs webcrypto),
 * jsonValid ~2.0x (vs JSON.parse).
 * Only applies while ffi is live — NAPI/Node/off keep the castrum decision
 * (there they lose).
 */
const FFI_WINS: ReadonlySet<string> = new Set([
  "etag",
  "validateIpv6",
  "hmacSha256",
  "randomToken",
  "jsonValid",
]);

/**
 * True when the Rust addon is loaded AND the selection table binds this op to
 * `castrum`. Ops where native is measured slower bind to the JS fallback even
 * when the addon is present. FFI_WINS overrides to native when the C-ABI
 * transport is live and the median benchmark proves a win.
 */
export const useNative = (op: OpName): boolean =>
  native != null && (SELECTION[op].impl === "castrum" || (ffi != null && FFI_WINS.has(op)));

/**
 * Per-op native handle resolved ONCE at module load — `native`/`ffi`/
 * `SELECTION` are fixed for the life of the process (see selection.ts), so the
 * hot per-op wrapper path is a single map lookup instead of re-evaluating the
 * selection table + FFI_WINS membership on every call.
 */
const IMPL: Record<OpName, NativeAddon | null> = Object.fromEntries(
  OPS.map((op) => [op, useNative(op) ? preferred : null]),
) as Record<OpName, NativeAddon | null>;

/**
 * The native handle for an op (C-ABI preferred, NAPI fallback), or `null` when
 * native is unavailable or the selection table binds the op to the JS fallback.
 * Use this in wrappers:
 *
 *   const n = nativeFor("fnv1a64");
 *   if (n) return n.fnv1a64(bytes);
 */
export const nativeFor = (op: OpName): NativeAddon | null => IMPL[op];

/** Which execution backend is active overall ("castrum" | "js"). */
export const backendName = (): ExecutionBackend => (native ? "castrum" : "js");
