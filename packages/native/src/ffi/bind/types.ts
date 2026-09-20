/**
 * @fileoverview Raw C-ABI symbol signatures for the `bun:ffi` primary surface
 * — the `(ptr,len)` argument contracts shared by the dlopen symbol table and
 * the surface builder. `usize`/`u64`/`u32` returns surface as bigint.
 *
 * Extracted from the pre-split `ffi/bind.ts` (move-only); re-exported by
 * `./index` only when a sibling needs a type.
 */

// Raw C-ABI symbol signatures (`usize`/`u64`/`u32` returns surface as bigint).
export type RawIn = (a: Uint8Array, al: number) => number | bigint;
export type Raw4 = (a: Uint8Array, al: number, b: Uint8Array, bl: number) => number | bigint;
export type Raw5 = (
  a: Uint8Array,
  al: number,
  b: number,
  c: Uint8Array,
  cl: number,
) => number | bigint;
export type Raw6 = (
  a: Uint8Array,
  al: number,
  b: Uint8Array,
  bl: number,
  c: Uint8Array,
  cl: number,
) => number | bigint;
export type Raw9 = (
  a: Uint8Array,
  al: number,
  b: Uint8Array,
  bl: number,
  c: Uint8Array,
  cl: number,
  d: number,
  e: Uint8Array,
  el: number,
) => number | bigint;
