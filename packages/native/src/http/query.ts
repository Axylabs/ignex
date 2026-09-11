/**
 * @fileoverview Query-string parsing.
 */

import { pairsToObject, readPairsPacked } from "../packed";
import { nativeFor } from "../runtime";
import { sizeGateAllowsNative } from "../selection";
import { fromBytes, toBytes } from "../util";
import { decodePairList } from "./pairs";
import type { Pairs } from "./types";

/**
 * Parse a query string into `[name, value]` pairs (duplicates preserved).
 *
 * Selection: native above 512B, js below (`SIZE_GATES.queryPairs`), and only
 * when the loaded addon's decoder passes the JS-compatibility probe
 * (`decode-compat.ts`). Measured 2026-09 (median of interleaved trials, with the
 * UTF-8 encode the wrapper must pay): 589B 1.17x, 843B 1.21x, 1.1KB 1.09x,
 * 2.2KB 1.19x, 3.3KB 1.20x; below ~440B JS wins by up to 0.80x, so those stay
 * JS. The gate is checked BEFORE `toBytes`: the JS path must not pay an encode
 * it never paid before.
 *
 * The probe exists because this op used to be pinned to JS for CORRECTNESS, not
 * speed: castrum before 0.9.5 threw `query: parse failed` on malformed escapes
 * (17,496 of 20,011 fuzzed inputs) and decoded invalid UTF-8 lossily, where JS's
 * `decodeURIComponent` throws and the fallback returns the segment raw. That is
 * fixed in the shared Rust decoder (`util::bytes::decode_form_component_into`,
 * one implementation for the packed parsers and the route stack), and the probe
 * keeps older addons on the JS path automatically.
 *
 * Note on input encoding: the native path receives `TextEncoder.encode(input)`,
 * so a STRING containing a lone surrogate (unrepresentable in UTF-8 — the engine
 * substitutes U+FFFD) is defined on those bytes. Such a string cannot come from
 * an HTTP request: URL bytes decode to well-formed UTF-16.
 */
export const queryPairs = (input: string | Uint8Array): Pairs => {
  // Gate first (a byte-count compare), then the addon binding: the common
  // small-query path pays neither an encode nor a native crossing.
  if (sizeGateAllowsNative("queryPairs", input.length)) {
    const n = nativeFor("queryPairs");
    if (n) return readPairsPacked(n.queryParsePacked(toBytes(input)));
  }
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
