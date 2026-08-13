/**
 * @fileoverview Shared pair-decoding for `application/x-www-form-urlencoded`
 * and query-string parsing. Consolidates the identical decode loop that used
 * to live in both `query` and `form`.
 */

import type { Pairs } from "./types";

/**
 * Decode a single name/value segment, skipping all work when it cannot
 * matter (Elysia's bit-flag decode-avoidance: `parseQueryFromURL` scans for
 * `%`/`+` before paying for `decodeURIComponent`). A segment with neither
 * character decodes to itself, so this is exact — query/form hot paths with
 * unencoded values never touch the regex or the decoder.
 */
const decodeSegment = (s: string): string => {
  if (s.indexOf("%") === -1 && s.indexOf("+") === -1) return s;
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
};

/** Split `a=1&b=2`-style text into decoded `[name, value]` pairs. */
export const decodePairList = (text: string): Pairs => {
  const out: Array<[string, string]> = [];
  if (!text) return out;
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const name = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    out.push([decodeSegment(name), decodeSegment(value)]);
  }
  return out;
};
