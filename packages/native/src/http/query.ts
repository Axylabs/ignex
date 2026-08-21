/**
 * @fileoverview Query-string parsing.
 */

import { pairsToObject } from "../packed";
import { fromBytes } from "../util";
import { decodePairList } from "./pairs";
import type { Pairs } from "./types";

/** Parse a query string into `[name, value]` pairs (duplicates preserved). */
export const queryPairs = (input: string | Uint8Array): Pairs => {
  // Selection: js — the packed C-ABI writer (`queryParsePacked`) measured
  // SLOWER (x0.96, scripts/bench-ffi.ts), so it is deliberately NOT selected
  // (native only where proven faster). The packed writers stay as the
  // C-ABI parity surface (verify-native-ffi.ts) + a published util.
  return queryPairsFallback(input);
};

/** Pure-TS fallback for {@link queryPairs} (identical behavior). */
export const queryPairsFallback = (input: string | Uint8Array): Pairs =>
  // The common hot path is a string (query substring / cookie header / form
  // body). Skip the toBytes→fromBytes round-trip (two heap copies) that used
  // to run before the decode loop even though these ops are bound to JS.
  decodePairList(typeof input === "string" ? input : fromBytes(input));

/** Parse a query string into an object (last value wins per key). */
export const parseQuery = (input: string | Uint8Array): Record<string, string> =>
  pairsToObject(queryPairs(input));
