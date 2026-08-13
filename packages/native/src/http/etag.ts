/**
 * @fileoverview ETag generation (crc32-based, strong or weak).
 */

import { crc32, toBytes } from "../util";

/** Generate a strong (`"<8-hex>"`) or weak (`W/"<8-hex>"`) ETag from a crc32. */
export const etag = (input: string | Uint8Array, weak = false): string => {
  // Selection: js (native x0.92) — see selection.ts.
  return etagFallback(toBytes(input), weak);
};

/** Pure-TS fallback for {@link etag} (identical behavior). */
export const etagFallback = (input: Uint8Array, weak: boolean): string => {
  const hex = (crc32(input) >>> 0).toString(16).padStart(8, "0");
  return weak ? `W/"${hex}"` : `"${hex}"`;
};
