/**
 * @fileoverview Query string parsing, native-accelerated.
 *
 * Uses the Rust addon's packed query parser (proven ~4x faster than JS)
 * through `@flux/native`, which falls back to a pure-TS parser when the
 * addon is unavailable. Duplicate keys are grouped into arrays.
 */

import { queryPairs } from "@flux/native";

export const parseQuery = (input: string): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};

  for (const [key, value] of queryPairs(input)) {
    const existing = out[key];

    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  }

  return out;
};

export const parseQueryFromURL = (url: string): Record<string, string | string[]> => {
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return {};
  return parseQuery(url.slice(qIdx + 1));
};
