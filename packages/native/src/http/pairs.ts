/**
 * @fileoverview Shared pair-decoding for `application/x-www-form-urlencoded`
 * and query-string parsing. Consolidates the identical decode loop that used
 * to live in both `query` and `form`.
 */

import type { Pairs } from "./types";

/** Split `a=1&b=2`-style text into decoded `[name, value]` pairs. */
export const decodePairList = (text: string): Pairs => {
  const out: Array<[string, string]> = [];
  if (!text) return out;
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      return s;
    }
  };
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const name = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    out.push([decode(name), decode(value)]);
  }
  return out;
};
