/**
 * @fileoverview Bun-native scalar/string reads over native output buffers.
 *
 * Applies the bun:ffi decode fast path discovered in the per-route stack to the
 * WHOLE `@ignex/native` surface: bun:ffi `read.u32/u64` avoid a per-call
 * `DataView` allocation ("usually faster ... it doesn't need to create a
 * DataView or ArrayBuffer" — bun docs) and `CString(ptr, offset, len)` is the
 * engine-native UTF-8→string read, both cheaper than `DataView` +
 * `TextDecoder.decode` on every value.
 *
 * Bun is the primary target; Node is second-class. Under Bun every read goes
 * through the pointer fast path (pointer resolved ONCE via {@link ffiBuf}, so a
 * pair loop does not re-call `ptr()` per field). Under Node the helpers fall
 * back to `DataView`/`TextDecoder` (byte-identical, just not accelerated).
 */

import { createRequire } from "node:module";
import { decoder } from "./util";

/** Structural view of the `bun:ffi` read/ptr/CString surface (no bun types). */
interface BunFfiRead {
  read: { u32(ptr: number, offset?: number): number; u64(ptr: number, offset?: number): bigint };
  ptr(buffer: Uint8Array): number;
  CString: new (ptr: number, byteOffset?: number, byteLength?: number) => string;
}

let bunFfi: BunFfiRead | null = null;
try {
  const mod = createRequire(import.meta.url)("bun:ffi") as Partial<BunFfiRead>;
  bunFfi =
    mod.read && typeof mod.ptr === "function" && typeof mod.CString === "function"
      ? (mod as BunFfiRead)
      : null;
} catch {
  bunFfi = null;
}

/** True when the bun:ffi read fast path is live (Bun only). */
export const isFfiReadAvailable = (): boolean => bunFfi !== null;

/**
 * A native output buffer pinned for fast reads. Under Bun `p` is the buffer's
 * pointer (resolved once, so hot loops never re-call `ptr()`); under Node `p`
 * is unused and `buf` drives the DataView fallback.
 */
export interface FfiBuf {
  readonly p: number;
  readonly buf: Uint8Array;
}

/** Pin a buffer for repeated fast reads (resolve the pointer once). */
export const ffiBuf = (buf: Uint8Array): FfiBuf =>
  bunFfi ? { p: bunFfi.ptr(buf), buf } : { p: 0, buf };

const fallbackView = (buf: Uint8Array): DataView =>
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

/** Read a little-endian u32 from `b` at byte `offset`. */
export const ffiU32 = (b: FfiBuf, offset: number): number =>
  bunFfi ? bunFfi.read.u32(b.p, offset) : fallbackView(b.buf).getUint32(offset, true);

/** Read a little-endian u64 from `b` at byte `offset`. */
export const ffiU64 = (b: FfiBuf, offset: number): bigint =>
  bunFfi ? bunFfi.read.u64(b.p, offset) : fallbackView(b.buf).getBigUint64(offset, true);

/** Read a UTF-8 string of `len` bytes from `b` at byte `offset`. */
export const ffiString = (b: FfiBuf, offset: number, len: number): string => {
  // Bun's CString rejects a 0 byteLength — emit "" for empty values.
  if (len === 0) return "";
  return bunFfi
    ? new bunFfi.CString(b.p, offset, len)
    : decoder.decode(b.buf.subarray(offset, offset + len));
};

/** Convenience single-shot u32 read (pins + reads). */
export const readU32 = (buf: Uint8Array, offset: number): number => ffiU32(ffiBuf(buf), offset);
/** Convenience single-shot u64 read (pins + reads). */
export const readU64 = (buf: Uint8Array, offset: number): bigint => ffiU64(ffiBuf(buf), offset);
/** Convenience single-shot string read (pins + reads). */
export const readString = (buf: Uint8Array, offset: number, len: number): string =>
  ffiString(ffiBuf(buf), offset, len);
