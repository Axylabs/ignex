/**
 * @fileoverview C-ABI transport helpers — mode resolution, the growExact
 * output convention, and small shared utilitities.
 *
 * Extracted from the pre-split `ffi.ts`: everything here is imported by the
 * sibling `bind.ts` / `self-test.ts` modules. Only `growExact` is part of the
 * public ffi surface (re-exported by `ffi/index.ts`).
 */
import type { FfiMode } from "./types";

/** True when running under the Bun runtime (`bun:ffi` is Bun-only). */
export const isBun = (): boolean => typeof process.versions.bun === "string";

/** Resolve `IGNEX_FFI_MODE` (`ffi`/`napi` explicit, `auto` default). */
export const resolveFfiMode = (): FfiMode => {
  const raw = process.env.IGNEX_FFI_MODE;
  return raw === "ffi" || raw === "napi" ? raw : "auto";
};

/**
 * Write with the C ABI's "needed" convention (`0` = error, `w > cap` = exact
 * required size → allocate once + retry, else `w` = written count).
 *
 * `initial` should be a TIGHT bound covering the common case in ONE call (the
 * whole point vs a `len*9`/`len*8` worst-case pre-size): on the rare miss the
 * C fn reports the EXACT size and this allocates once and retries — never a
 * doubling re-run loop.
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

/**
 * Default cap for variable-size native outputs. Bounds a single FFI call's
 * worst-case allocation — a lying addon misreporting `needed` near the cap is
 * a memory-exhaustion DoS, and the old 1 GiB ceiling was far too generous.
 * 128 MiB aligns with the generated server's default `maxRequestBodySize` and
 * stays well under the former ceiling. Overridable via `IGNEX_MAX_VAR_OUTPUT`
 * (bytes) for apps that legitimately need larger variable-size native outputs.
 */
const DEFAULT_MAX_VAR_OUTPUT = 128 * 1024 * 1024;

/** Process-wide cap for `growExact` outputs (see {@link DEFAULT_MAX_VAR_OUTPUT}). */
export const MAX_VAR_OUTPUT = (() => {
  const raw = process.env.IGNEX_MAX_VAR_OUTPUT;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_MAX_VAR_OUTPUT;
})();

/**
 * Parse the cstring claims JSON the C-ABI returns. `null`/empty → `null`
 * (invalid token); malformed JSON → `null` too, matching the pure-TS fallbacks
 * (`crypto.ts`/`ed25519.ts` guard with try/catch). A castrum bug emitting
 * malformed claims must not throw synchronously out of the FFI wrapper — it
 * would surface as a 500 (or worse) instead of a clean `null` rejection.
 */
export const safeJsonParse = (v: string | null): unknown => {
  if (v === null || v === "") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

/** Byte-equality helper for the bind-time parity self-test. */
export const eq = (a: Uint8Array | null, b: Uint8Array | null): boolean =>
  a != null &&
  b != null &&
  a.length === b.length &&
  Buffer.from(a).toString("hex") === Buffer.from(b).toString("hex");

/** True when `a` is a lowercase-hex string (in bytes). */
export const isHex = (a: Uint8Array): boolean => /^[0-9a-f]+$/.test(Buffer.from(a).toString());
