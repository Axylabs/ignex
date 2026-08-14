/**
 * @fileoverview ETag generation (crc32-based, strong or weak).
 */

import { nativeFor } from "../runtime";
import { crc32, fromBytes, toBytes } from "../util";

/**
 * Generate a strong (`"<8-hex>"`) or weak (`W/"<8-hex>"`) ETag from a crc32.
 * C-ABI is PROVEN faster than the JS fallback (~1.05-1.21x median, see
 * `scripts/bench-ffi.ts`) and byte-identical, so nativeFor("etag") is used
 * when the ffi transport is live; NAPI/Node keep the JS fallback (0.28x there).
 */
export const etag = (input: string | Uint8Array, weak = false): string => {
  const n = nativeFor("etag");
  if (n) return fromBytes(n.etag(toBytes(input), weak));
  return etagFallback(toBytes(input), weak);
};

/** Pure-TS fallback for {@link etag} (identical behavior). */
export const etagFallback = (input: Uint8Array, weak: boolean): string => {
  const hex = (crc32(input) >>> 0).toString(16).padStart(8, "0");
  return weak ? `W/"${hex}"` : `"${hex}"`;
};
