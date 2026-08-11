/**
 * @fileoverview `application/x-www-form-urlencoded` body parsing.
 */

import { pairsToObject } from "../packed";
import { fromBytes, toBytes } from "../util";
import { decodePairList } from "./pairs";
import type { Pairs } from "./types";

/** Parse a `x-www-form-urlencoded` body into `[name, value]` pairs. */
export const formPairs = (input: string | Uint8Array): Pairs => {
  // Selection: js (native x0.88) — see selection.ts.
  return formPairsFallback(toBytes(input));
};

export const formPairsFallback = (input: Uint8Array): Pairs => decodePairList(fromBytes(input));

/** Parse a `x-www-form-urlencoded` body into an object (last value wins). */
export const parseForm = (input: string | Uint8Array): Record<string, string> =>
  pairsToObject(formPairs(input));
