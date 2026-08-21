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
import { type ExecutionBackend, type OpName, SELECTION } from "./selection";

/** The loaded castrum NAPI addon (or `null` when unavailable). Resolved once at import — the documented "never throws on import" contract. */
export const native = getNative();

/**
 * The C-ABI (`bun:ffi`) surface, bound + self-tested LAZILY on first use —
 * not at module load. Binding runs the bind-time parity self-test and, under
 * `IGNEX_FFI_MODE=ffi` (forced), THROWS on a broken addon. Deferring it means
 * a consumer that imports `@ignex/native` but never calls a native op pays no
 * bind cost and cannot crash at import (the documented lazy contract).
 */
let ffiValue: ReturnType<typeof getFfi> | null | undefined;
const getFfiLazy = (): ReturnType<typeof getFfi> | null => {
  if (ffiValue === undefined) ffiValue = getFfi();
  return ffiValue;
};

/**
 * A single handle that prefers the C-ABI binding for the ops it covers and
 * falls through to the NAPI addon for everything else (stateful classes,
 * `opImpl`, thread-pool init, …). Wrappers keep calling `n.op(...)` unchanged.
 * Resolved lazily (depends on the lazy FFI bind).
 */
let preferredValue: NativeAddon | null | undefined;
const getPreferred = (): NativeAddon | null => {
  if (preferredValue === undefined) {
    preferredValue =
      native != null && getFfiLazy() != null
        ? new Proxy(native, {
            get(target, prop, receiver) {
              const f = (getFfiLazy() as unknown as Record<PropertyKey, unknown>)[prop];
              if (typeof f === "function") return f;
              return Reflect.get(target, prop, receiver);
            },
          })
        : native;
  }
  return preferredValue;
};

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
  // NOTE: `queryToJson`/`cookiesToJson` were dropped from FFI_WINS — castrum
  // removed the `castrum_query_to_json`/`castrum_cookies_to_json` C-ABI
  // symbols; the ops were JS-only and have since been removed entirely.
]);

/**
 * True when the Rust addon is loaded AND the selection table binds this op to
 * `castrum`. Ops where native is measured slower bind to the JS fallback even
 * when the addon is present. FFI_WINS overrides to native when the C-ABI
 * transport is live and the median benchmark proves a win.
 *
 * The first call triggers the (once-per-process) lazy FFI bind + self-test.
 */
export const useNative = (op: OpName): boolean =>
  native != null &&
  (SELECTION[op].impl === "castrum" || (getFfiLazy() != null && FFI_WINS.has(op)));

/** Per-op native-handle cache (lazily populated on first `nativeFor`). */
const implCache = new Map<OpName, NativeAddon | null>();

/**
 * Per-op native handle, resolved lazily and memoized per op (the FFI bind is
 * triggered on first use, not at import). Returns the C-ABI-preferred handle,
 * the NAPI fallback, or `null` when native is unavailable or the selection
 * table binds the op to the JS fallback. Use this in wrappers:
 *
 *   const n = nativeFor("fnv1a64");
 *   if (n) return n.fnv1a64(bytes);
 */
export const nativeFor = (op: OpName): NativeAddon | null => {
  const cached = implCache.get(op);
  if (cached !== undefined) return cached;
  const value = useNative(op) ? getPreferred() : null;
  implCache.set(op, value);
  return value;
};

/** Which execution backend is active overall ("castrum" | "js"). */
export const backendName = (): ExecutionBackend => (native ? "castrum" : "js");
