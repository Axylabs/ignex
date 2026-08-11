/**
 * @fileoverview Query-string parsing.
 */

import { pairsToObject } from "../packed";
import { fromBytes, toBytes } from "../util";
import { decodePairList } from "./pairs";
import type { Pairs } from "./types";

/** Parse a query string into `[name, value]` pairs (duplicates preserved). */
export const queryPairs = (input: string | Uint8Array): Pairs => {
  // Selection: js (native x0.96) — see selection.ts.
  return queryPairsFallback(toBytes(input));
};

export const queryPairsFallback = (input: Uint8Array): Pairs => decodePairList(fromBytes(input));

/** Parse a query string into an object (last value wins per key). */
export const parseQuery = (input: string | Uint8Array): Record<string, string> =>
  pairsToObject(queryPairs(input));
