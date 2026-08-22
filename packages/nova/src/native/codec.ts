/**
 * Zero-allocation UTF-8 helpers (Bun, server-side). Used by the generated
 * direct fast-path encoders to turn JS strings into pre-encoded byte buffers
 * WITHOUT allocating: write into a reusable scratch via a cached `Buffer` view
 * (castrum's `encodeUtf8Into` pattern).
 */
import { Buffer } from "node:buffer";

const viewCache = new WeakMap<ArrayBuffer, Buffer>();

function bufView(ab: ArrayBuffer): Buffer {
  let b = viewCache.get(ab);
  if (!b) {
    b = Buffer.from(ab);
    viewCache.set(ab, b);
  }
  return b;
}

/** UTF-8 byte length of `s` — no allocation. */
export function utf8Len(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Write `s` as UTF-8 into `dest` at `offset`; returns bytes written. */
export function encodeUtf8Into(s: string, dest: Uint8Array, offset = 0): number {
  return bufView(dest.buffer as ArrayBuffer).write(s, offset, "utf8");
}

/** Grow a scratch in place (returns a new buffer) if it can't hold `needed`. */
export function ensureCapacity(current: Uint8Array, needed: number, minGrow = 64): Uint8Array {
  if (current.byteLength >= needed) return current;
  const cap = Math.max(current.byteLength * 2, needed, minGrow);
  return new Uint8Array(cap);
}
