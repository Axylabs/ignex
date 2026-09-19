/**
 * @fileoverview Cookie-header parsing.
 */

import { pairsToObject } from "../packed";
import { fromBytes } from "../util";
import type { Pairs } from "./types";

/** Parse a `Cookie` header into `[name, value]` pairs. */
export const cookiePairs = (input: string | Uint8Array): Pairs => {
  // Selection: js — re-measured 2026-09 with the ASCII decode fast path: the
  // packed C-ABI writer (`cookieParsePacked`) still loses (x0.78 median, a
  // 30-cookie/602B header), so it is deliberately NOT selected. A cookie
  // header is one flat `;`-separated list with no percent-decoding, which is
  // exactly what `String.split` is best at. It stays as the C-ABI parity
  // surface (verify-native-ffi.ts) + a published util. `queryPairs`, whose
  // values ARE percent-decoded, does win past 512B and is selected there.
  return cookiePairsFallback(input);
};

/** Pure-TS fallback for {@link cookiePairs} (identical behavior). */
export const cookiePairsFallback = (input: string | Uint8Array): Pairs => {
  const out: Array<[string, string]> = [];
  // Skip the toBytes→fromBytes round-trip for the common string hot path.
  const text = typeof input === "string" ? input : fromBytes(input);
  if (!text) return out;
  const unquote = (s: string): string =>
    s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
  for (const part of text.split(";")) {
    const eq = part.indexOf("=");
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    const value = eq < 0 ? "" : unquote(part.slice(eq + 1).trim());
    if (name) out.push([name, value]);
  }
  return out;
};

/** Parse a `Cookie` header into an object (last value wins per key). */
export const parseCookie = (input: string | Uint8Array): Record<string, string> =>
  pairsToObject(cookiePairs(input));

/**
 * Bulk fused cookie-pairs STATS — twin of {@link cookiePairsStats} over the
 * cookie header glue (count + total decoded byte length, no per-pair string
 * materialization). Native gate mirrors {@link cookiePairs}'s gate selection
 * exactly (a cookie header is a flat `;`-list; native is NOT selected for
 * cookiePairs — the stats walk twins the same gate, so parity holds).
 */
export const cookiePairsStats = (
  input: string | Uint8Array,
): { readonly count: number; readonly totalDecodedLen: number } =>
  cookiePairsStatsFallback(input);

/** Pure-TS fallback for {@link cookiePairsStats} (identical behavior). */
export const cookiePairsStatsFallback = (
  input: string | Uint8Array,
): { readonly count: number; readonly totalDecodedLen: number } => {
  const pairs = cookiePairsFallback(input);
  let total = 0;
  for (const [name, value] of pairs) total += name.length + value.length;
  return { count: pairs.length, totalDecodedLen: total };
};
