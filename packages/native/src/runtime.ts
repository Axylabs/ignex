/**
 * Runtime execution seam — the ONLY module that combines addon availability
 * with the selection table. Wrappers ask `useNative(op)` instead of checking
 * `getNative()` themselves, so "is native loaded" and "does native win for
 * this op" are answered in one place, from the single source of truth in
 * `./selection.ts`.
 */

import { nativeQueryDecodeMatchesJs } from "./decode-compat";
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
  // `crc32`: Bun's builtin wins on the ADDON (napi) transport — 36.7ns vs
  // 202ns, 5.5x — which is why the op is in `BUN_WINS` (the base decision). On
  // the C-ABI it is the opposite: the Rust crc32 (crc32fast, SIMD) does
  // 19-22ns against Bun's 36-38ns = **1.7-1.9x**, measured on BOTH addon
  // variants (baseline and x86-64-v3) with 100k-op trials, cv 2-6%. Same
  // dual-set shape as `hmacSha256`/`randomToken`: Bun builtin on NAPI, Rust on
  // the C-ABI. crc32 is on the etag/checksum path, so this is per-request.
  "crc32",
  // `validateUuid`: the C-ABI cstring validator does 36.6ns against the JS
  // regex's 41.2ns — a real but modest **1.13x** (cv 1%, varied input).
  // The SIBLINGS do NOT get this treatment and must not be "optimized" back:
  // `validateEmail` is 139ns native vs 38.8ns JS (JS wins 3.6x) and
  // `validateIpv4` 64.1ns vs 36.7ns (JS wins 1.75x). `validateIpv6` (101ns vs
  // 252ns, native 2.49x) is below, and `jsonValid` is size-gated at 256B.
  "validateUuid",
  // `aeadEncrypt`: the static table is `js` because the ADDON (napi) transport
  // loses to the JS fallback (0.86-0.93x). On the C-ABI transport the same op
  // WINS by a wide margin — measured 2026-09, raw surfaces, median of 11
  // interleaved trials: 2.02x @64B, 1.94x @79B, 1.73x @512B, 1.47x @2KB,
  // 1.64x @4KB, 1.20x @16KB (ciphertext-identical, verified). Session/token
  // encryption is a per-request path, so this is one of the larger wins here.
  "aeadEncrypt",
  // `queryPairs`: castrum's `opImpl` says "js" from its own NAPI-era benchmark,
  // but under the C-ABI transport the packed parse (plus the `readPairsSection`
  // ASCII fast path) beats the JS split loop past ~512B — 1.17x at 589B, 1.21x
  // at 843B, 1.19-1.20x at 2.2-3.3KB, with the wrapper's UTF-8 encode counted
  // (below ~440B JS wins; `SIZE_GATES.queryPairs` handles that).
  //
  // Gated on `nativeQueryDecodeMatchesJs()`: selecting it is only CORRECT when
  // the addon's form decoder implements JS `decodeURIComponent` semantics
  // (raw segment on a malformed escape). Addons before 0.9.5 threw
  // `query: parse failed` on 17,496/20,011 fuzzed malformed inputs, so the op
  // stays on JS for those builds instead of turning a bad query into a 500.
  "queryPairs",
  // NOTE: `queryToJson`/`cookiesToJson` were dropped from FFI_WINS — castrum
  // removed the `castrum_query_to_json`/`castrum_cookies_to_json` C-ABI
  // symbols; the ops were JS-only and have since been removed entirely.
  // `cookiePairs` was re-measured with the new decoder (0.78x) and stays JS.
]);

/**
 * Whether an `FFI_WINS` op is allowed to run native on THIS addon build.
 *
 * `queryPairs` needs more than a live ffi bind: its win is only realizable on a
 * decoder that answers like the JS fallback (see `decode-compat.ts`), so an
 * older addon keeps the op on JS even though the median says native.
 */
const ffiOverrideAllowed = (op: OpName): boolean =>
  op !== "queryPairs" || nativeQueryDecodeMatchesJs();

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
  (SELECTION[op].impl === "castrum" ||
    (getFfiLazy() != null && FFI_WINS.has(op) && ffiOverrideAllowed(op)));

/**
 * The EFFECTIVE implementation for `op` on this process right now
 * (`"castrum"` | `"js"`), accounting for the static table AND the live-FFI
 * overrides. `SELECTION[op].impl` stays the immutable compile-time decision;
 * this answers "what actually runs" (the two can differ under the C-ABI
 * transport — queryable here instead of being an invisible divergence).
 */
export const effectiveImplFor = (op: OpName): ExecutionBackend =>
  useNative(op) ? "castrum" : "js";

/**
 * Eagerly force the lazy C-ABI bind + parity self-test at boot.
 *
 * Without this, the bind (~40 assertions incl. Ed25519/AEAD roundtrips) runs
 * inside the FIRST `useNative()` call — i.e., on the first real request after
 * every deploy/restart, adding a one-off latency spike to it. Call once during
 * startup (after `initNative`) to move that cost to load time. Idempotent;
 * never throws.
 */
export const warmRuntime = (): void => {
  try {
    getFfiLazy();
    getPreferred();
    implCache.clear();
  } catch {
    // A failed warmup leaves the lazy path intact — first use will retry.
    implCache.clear();
  }
};

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
