/**
 * FFI margin pinpointer — isolates the fixed per-call `bun:ffi` cost into its
 * components (mirrors castrum's `bench/ffi-margin.ts` probes):
 *
 *   floor       = the irreducible C-ABI crossing cost
 *   + view conv = TypedArray-view→pointer resolution for a (buffer, buffer_length)
 *                 / (ptr, len) pair
 *   + scalar    = scalar arg/return conversion (usize vs u64_fast → BigInt boxing)
 *   + cstring   = engine-side JS-string→UTF-8 transcode to a call-scoped
 *                 NUL-terminated buffer (the `cstring` ARG cost) vs a JS-side
 *                 pre-encoded scratch + (ptr,len)
 *
 * The `ffi_probe_*` symbols are diagnostic-only (`rust/src/ffi.rs`), NOT part of
 * the shipped dlopen map.
 *
 *   bun run bench:ffi-margin
 */
import { dlopen, type FFITypeOrString } from "bun:ffi";
import { getAddonPath } from "../src/native/loader";
import { measureNs } from "./measure";

type RawFn = (...a: unknown[]) => number | bigint | undefined;

function bindRaw(
  path: string,
  symbol: string,
  args: readonly FFITypeOrString[],
  returns: FFITypeOrString,
): RawFn | null {
  try {
    const { symbols } = dlopen(path, {
      [symbol]: { args, returns },
    });
    // Deliberately never close(): dlclose-on-GC is unsound and each probe needs
    // its symbol live for the whole measurement (bun:ffi lifetime rule).
    return (symbols as unknown as Record<string, RawFn>)[symbol] ?? null;
  } catch {
    return null;
  }
}

const U64_FAST = "u64_fast" as unknown as FFITypeOrString;

const path = getAddonPath();
const view = new Uint8Array([0x61, 0x61, 0x70, 0x6c]); // "aapl"

// Each probe is dlopen'd with the exact ABI variant being measured.
const noop = bindRaw(path, "ffi_probe_noop", [], "void");
const echoUsize = bindRaw(path, "ffi_probe_echo_usize", ["usize"], "usize");
const echoU64Fast = bindRaw(path, "ffi_probe_echo_usize", ["usize"], U64_FAST);
// `buffer_length` is an unofficial literal (bun-types' FFITypeOrString omits it) — cast.
const echoViewPair = bindRaw(
  path,
  "ffi_probe_echo_view",
  ["buffer", "buffer_length"] as unknown as readonly FFITypeOrString[],
  "usize",
);
const echoViewPtrLen = bindRaw(path, "ffi_probe_echo_view", ["ptr", "usize"], "usize");
const echoCstr = bindRaw(path, "ffi_probe_echo_cstr", ["cstring"], "usize");

const row = (label: string, ns: number) =>
  console.log(`  ${label.padEnd(42)} ${String(ns).padStart(6)} ns`);

console.log("ffi margin (min-of-N ns/op):");
if (noop)
  row(
    "noop (bare trampoline floor)",
    measureNs(() => noop()),
  );
if (echoUsize)
  row(
    "echo_usize (usize→BigInt return)",
    measureNs(() => echoUsize(7)),
  );
if (echoU64Fast)
  row(
    "echo_usize (u64_fast return)",
    measureNs(() => echoU64Fast(7)),
  );
if (echoViewPair)
  row(
    "echo_view (buffer+buffer_length pair)",
    measureNs(() => echoViewPair(view, view)),
  );
if (echoViewPtrLen)
  row(
    "echo_view (ptr,usize explicit)",
    measureNs(() => echoViewPtrLen(view, view.byteLength)),
  );
if (echoCstr)
  row(
    "echo_cstr (cstring ARG transcode)",
    measureNs(() => echoCstr("aapl")),
  );
