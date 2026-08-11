/**
 * @fileoverview Query string parsing.
 *
 * Delegates to `@flux/native` `queryPairs`, whose selection table
 * (`packages/native/src/selection.ts`) owns the impl choice — the scalar
 * pure-TS parser is the fast path (native measures x0.96 on the 2026-08-11
 * bench), and the native packed parser stays available for batched large
 * inputs. Duplicate keys are grouped into arrays.
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
