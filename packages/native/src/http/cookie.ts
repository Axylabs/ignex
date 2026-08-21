/**
 * @fileoverview Cookie-header parsing.
 */

import { pairsToObject } from "../packed";
import { fromBytes } from "../util";
import type { Pairs } from "./types";

/** Parse a `Cookie` header into `[name, value]` pairs. */
export const cookiePairs = (input: string | Uint8Array): Pairs => {
  // Selection: js — the packed C-ABI writer (`cookieParsePacked`) measured
  // SLOWER (x0.65, scripts/bench-ffi.ts), so it is deliberately NOT selected
  // (native only where proven faster). It stays as the C-ABI parity surface.
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
