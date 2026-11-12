/**
 * @fileoverview Query-string parsing.
 */

import { createAdaptiveExecutor } from "../adaptive";
import { pairsToObject, readPairsPacked, readPairsStatsPacked } from "../packed";
import { nativeFor } from "../runtime";
import { sizeGateAllowsNative } from "../selection";
import { fromBytes, toBytes } from "../util";
import { decodePairList } from "./pairs";
import type { Pairs } from "./types";

const queryExecution = createAdaptiveExecutor({
  enabled: process.env.IGNEX_ADAPTIVE !== "off" && process.env.IGNEX_SIZE_GATES !== "off",
  sizeBuckets: [511, 4096, 65_536],
  initialImpl: (bytes) => (sizeGateAllowsNative("queryPairs", bytes) ? "castrum" : "js"),
  nativeAvailable: () => nativeFor("queryPairs") !== null,
});

/**
 * Parse a query string into `[name, value]` pairs (duplicates preserved).
 * Measured size gates provide the cold-start preference; sampled live timings
 * then adapt each size bucket. Native runs only when the decoder passes the
 * JS-compatibility probe. The small-input JS path still avoids UTF-8 encoding.
 */
export const queryPairs = (input: string | Uint8Array): Pairs => {
  const choice = queryExecution.choose(input.length);
  if (choice === false) return queryPairsFallback(input);
  if (choice === true) {
    const n = nativeFor("queryPairs");
    return n ? readPairsPacked(n.queryParsePacked(toBytes(input))) : queryPairsFallback(input);
  }
  try {
    if (choice.impl === "js") return queryPairsFallback(input);
    const n = nativeFor("queryPairs");
    return n ? readPairsPacked(n.queryParsePacked(toBytes(input))) : queryPairsFallback(input);
  } finally {
    queryExecution.record(choice);
  }
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

const queryStatsExecution = createAdaptiveExecutor({
  enabled: process.env.IGNEX_ADAPTIVE !== "off" && process.env.IGNEX_SIZE_GATES !== "off",
  sizeBuckets: [511, 4096, 65_536],
  initialImpl: (bytes) => (sizeGateAllowsNative("queryPairs", bytes) ? "castrum" : "js"),
  nativeAvailable: () => nativeFor("queryPairs") !== null,
});

/**
 * Bulk fused query-pairs STATS: walk the SAME packed buffer without
 * materializing per-pair JS strings. Its adaptive model is separate from
 * {@link queryPairs} because the JS read cost differs; parity is unchanged.
 */
export const queryPairsStats = (
  input: string | Uint8Array,
): { readonly count: number; readonly totalDecodedLen: number } => {
  const choice = queryStatsExecution.choose(input.length);
  if (choice === false) return queryPairsStatsFallback(input);
  if (choice === true) {
    const n = nativeFor("queryPairs");
    return n
      ? readPairsStatsPacked(n.queryParsePacked(toBytes(input)))
      : queryPairsStatsFallback(input);
  }
  try {
    if (choice.impl === "js") return queryPairsStatsFallback(input);
    const n = nativeFor("queryPairs");
    return n
      ? readPairsStatsPacked(n.queryParsePacked(toBytes(input)))
      : queryPairsStatsFallback(input);
  } finally {
    queryStatsExecution.record(choice);
  }
};

/** Pure-TS fallback for {@link queryPairsStats} (identical behavior). */
export const queryPairsStatsFallback = (
  input: string | Uint8Array,
): { readonly count: number; readonly totalDecodedLen: number } => {
  let count = 0;
  let total = 0;
  for (const [name, value] of typeof input === "string"
    ? queryPairsFallback(input)
    : queryPairsFallback(input)) {
    // byte-parity: fallback handles both inputs identically
    count += 1;
    total += name.length + value.length;
  }
  return { count, totalDecodedLen: total };
};
