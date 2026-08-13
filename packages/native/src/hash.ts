/**
 * Fast hashing primitives (native-accelerated, FNV-1a 64 / CRC-32).
 *
 * The native addon exposes FNV-1a 64-bit and CRC-32; both are proven faster
 * than their JS equivalents on the addon's benchmark registry, so we prefer
 * native and keep a pure-TS implementation that is bit-for-bit identical.
 */

import { bunCrc32 } from "./bun";
import { nativeFor } from "./runtime";
import { crc32 as crc32Fallback, toBytes } from "./util";

/** FNV-1a 64-bit hash. */
export const fnv1a64 = (input: string | Uint8Array): bigint => {
  const bytes = toBytes(input);
  const n = nativeFor("fnv1a64");
  if (n) return n.fnv1a64(bytes);
  return fnv1a64Fallback(bytes);
};

/** Pure-TS FNV-1a 64-bit implementation (test vector: `fnv1a64("")` is the offset basis). */
export const fnv1a64Fallback = (input: Uint8Array): bigint => {
  let h = 0xcbf29ce484222325n;
  for (const byte of input) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
};

/** CRC-32 checksum (unsigned 32-bit number). */
export const crc32 = (input: string | Uint8Array): number => {
  const bytes = toBytes(input);
  const n = nativeFor("crc32");
  if (n) return n.crc32(bytes);
  // Under Bun, `Bun.hash.crc32` (C++ SIMD) beats both Rust and the TS table.
  if (bunCrc32) return bunCrc32(bytes);
  return crc32Fallback(bytes);
};

/** FNV-1a 64-bit hash of a string (convenience for cache keys / fingerprints). */
export const fnv1a64String = (input: string): string => fnv1a64(input).toString(16);
