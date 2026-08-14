/**
 * @fileoverview `application/x-www-form-urlencoded` body parsing.
 */

import { pairsToObject } from "../packed";
import { fromBytes } from "../util";
import { decodePairList } from "./pairs";
import type { Pairs } from "./types";

/** Parse a `x-www-form-urlencoded` body into `[name, value]` pairs. */
export const formPairs = (input: string | Uint8Array): Pairs => {
  // Selection: js (native x0.88) — see selection.ts.
  return formPairsFallback(input);
};

/** Pure-TS fallback for {@link formPairs} (identical behavior). */
export const formPairsFallback = (input: string | Uint8Array): Pairs =>
  // Skip the toBytes→fromBytes round-trip for the common string hot path.
  decodePairList(typeof input === "string" ? input : fromBytes(input));

/** Parse a `x-www-form-urlencoded` body into an object (last value wins). */
export const parseForm = (input: string | Uint8Array): Record<string, string> =>
  pairsToObject(formPairs(input));
