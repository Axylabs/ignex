/**
 * @fileoverview Query string parsing.
 *
 * Delegates to `@ignus/native` `queryPairs`, whose selection table
 * (`packages/native/src/selection.ts`) owns the impl choice — the scalar
 * pure-TS parser is the fast path (native measures x0.96 on the 2026-08-11
 * bench), and the native packed parser stays available for batched large
 * inputs. Duplicate keys are grouped into arrays.
 */

import { batch, queryPairs } from "@ignus/native";

/**
 * Group raw `[name, value]` pairs into an object. Duplicate keys become
 * arrays (`a=1&a=2` → `{ a: ["1", "2"] }`); single keys stay strings.
 */
const groupQueryPairs = (
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
 * Minimum input count for the native BATCH pair parse to beat per-item scalar
 * JS: one packed FFI call amortized across many inputs. Below this the scalar
 * parser wins (native measures x0.96 on a single query string — selection.ts).
 */
export const BATCH_PARSE_THRESHOLD = 4;

/**
 * Parse many query strings in ONE native batch call — for bulk endpoints that
 * receive many payloads per request (imports, analytics ingestion). Output is
 * identical to calling {@link parseQuery} per input. Falls back to per-item
 * scalar parsing below {@link BATCH_PARSE_THRESHOLD} inputs or when the Rust
 * addon is absent.
 *
 * @param inputs Raw query strings (the part after `?`).
 * @returns One grouped `Record<string, string | string[]>` per input.
 */
export const parseQueries = (
  inputs: ReadonlyArray<string>,
): Array<Record<string, string | string[]>> =>
  inputs.length >= BATCH_PARSE_THRESHOLD
    ? batch.queryParse(inputs).map(groupQueryPairs)
    : inputs.map(parseQuery);

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
