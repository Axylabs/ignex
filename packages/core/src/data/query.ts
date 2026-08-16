/**
 * @fileoverview Query string parsing.
 *
 * Delegates to `@ignex/native` `queryPairs`, whose selection table
 * (`packages/native/src/selection.ts`) owns the impl choice — the scalar
 * pure-TS parser is the fast path (native measures x0.96 on the 2026-08-11
 * bench), and the native packed parser stays available for batched large
 * inputs. Duplicate keys are grouped into arrays.
 */

import { queryPairs } from "@ignex/native";

/**
 * Group raw `[name, value]` pairs into an object. Duplicate keys become
 * arrays (`a=1&a=2` → `{ a: ["1", "2"] }`); single keys stay strings.
 */
export const groupQueryPairs = (
  pairs: ReadonlyArray<[string, string]>,
): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};

  for (const [key, value] of pairs) {
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

/**
 * Parse a query string into a grouped record.
 *
 * Duplicate keys become arrays (`a=1&a=2` → `{ a: ["1", "2"] }`); single
 * keys stay strings. Malformed percent-encoding does not throw — values are
 * kept raw.
 *
 * @param input - The query string (the part after `?`).
 * @returns Grouped values keyed by name.
 */
export const parseQuery = (input: string): Record<string, string | string[]> =>
  groupQueryPairs(queryPairs(input));

/**
 * Parse the query portion of a URL string.
 *
 * Returns an empty record when there is no `?`.
 *
 * @param url - A full URL (or URL-like string).
 * @returns Grouped query values keyed by name.
 */
export const parseQueryFromURL = (url: string): Record<string, string | string[]> => {
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return {};
  return parseQuery(url.slice(qIdx + 1));
};
