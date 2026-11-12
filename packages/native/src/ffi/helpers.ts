/**
 * @fileoverview C-ABI output sizing and JSON helpers shared by the framework
 * adapters. Only `growExact` is re-exported by `ffi/index.ts`.
 */
import type { FfiMode } from "./types";

/** Resolve `IGNEX_FFI_MODE` (`ffi`/`napi` explicit, `auto` default). */
export const resolveFfiMode = (): FfiMode => {
  const raw = process.env.IGNEX_FFI_MODE;
  return raw === "ffi" || raw === "napi" ? raw : "auto";
};

/**
 * Write with the C ABI's needed-size convention (`0` = error, `w > cap` =
 * exact required size → allocate once + retry, else `w` = written count).
 */
export function growExact(
  write: (out: Uint8Array) => number,
  initial: number,
  max: number,
  error: string,
): Uint8Array {
  let cap = Math.min(Math.max(initial, 16), max);
  for (;;) {
    const out = new Uint8Array(cap);
    const w = Number(write(out));
    if (w === 0) throw new Error(error);
    if (w <= out.length) return out.subarray(0, w);
    if (w > max) throw new Error(error);
    cap = Math.min(w, max);
  }
}

/** Parse claims JSON, returning `null` for absent or malformed payloads. */
export const safeJsonParse = (v: string | null): unknown => {
  if (v === null || v === "") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};
