/**
 * @fileoverview Query string parsing.
 *
 * Delegates to `@ignex/native` `queryPairs`, whose selection table
 * (`packages/native/src/selection.ts`) owns the impl choice — the scalar
 * pure-TS parser is the fast path (native measures x0.96 on the 2026-08-11
 * bench), and the native packed parser stays available for batched large
 * inputs. Duplicate keys are grouped into arrays.
 */

import { isNativeAvailable, queryPairs } from "@ignex/native";

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

/**
 * Read-only, `URLSearchParams`-compatible facade over a list of
 * `[name, value]` pairs produced by the Rust per-route stack (or any pairs
 * source). Synced from the castrum performance direction: the compiled
 * server's native prelude seeds `ctx.query` with this instead of building a
 * `URLSearchParams` from the raw string — the Rust parse + pair iteration
 * measures ~4× faster than `new URLSearchParams(queryString)` on a
 * 20-parameter query (~1.4µs vs ~5.7µs) while preserving the exact
 * `ctx.query` contract (iteration, `.get`, `.has`, `.getAll`, `.size`,
 * `.toString`, `.forEach`).
 *
 * Duplicate keys are preserved as separate entries (URLSearchParams
 * semantics), and `.get(name)` returns the first value or `null` — matching
 * `URLSearchParams`, so `ctx.query.get("name") ?? default` keeps working.
 */
export class NativeQueryParams implements Iterable<[string, string]> {
  readonly #pairs: ReadonlyArray<[string, string]>;

  /** Wrap pre-parsed `[name, value]` pairs (no string re-parse). */
  constructor(pairs: ReadonlyArray<[string, string]>) {
    this.#pairs = pairs;
  }

  /** Iterate `[name, value]` entries (URLSearchParams order). */
  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.#pairs[Symbol.iterator]();
  }

  /** First value for `name`, or `null` (URLSearchParams parity). */
  get(name: string): string | null {
    for (const [k, v] of this.#pairs) {
      if (k === name) return v;
    }
    return null;
  }

  /** Whether at least one value exists for `name`. */
  has(name: string): boolean {
    for (const [k] of this.#pairs) {
      if (k === name) return true;
    }
    return false;
  }

  /** All values for `name` (duplicates preserved). */
  getAll(name: string): string[] {
    const out: string[] = [];
    for (const [k, v] of this.#pairs) {
      if (k === name) out.push(v);
    }
    return out;
  }

  /** Number of raw pairs (URLSearchParams `.size` parity). */
  get size(): number {
    return this.#pairs.length;
  }

  /** `[name, value]` entry iterator. */
  entries(): IterableIterator<[string, string]> {
    return this.#pairs[Symbol.iterator]();
  }

  /** Name iterator. */
  *keys(): IterableIterator<string> {
    for (const [k] of this.#pairs) yield k;
  }

  /** Value iterator. */
  *values(): IterableIterator<string> {
    for (const [, v] of this.#pairs) yield v;
  }

  /** `name=value&…` serialization (percent-encoded, URLSearchParams parity). */
  toString(): string {
    let out = "";
    for (const [k, v] of this.#pairs) {
      if (out !== "") out += "&";
      out += `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    }
    return out;
  }

  /** Call `cb(value, name, this)` for every pair (URLSearchParams parity). */
  forEach(
    cb: (value: string, name: string, params: NativeQueryParams) => void,
    thisArg?: unknown,
  ): void {
    for (const [k, v] of this.#pairs) {
      cb.call(thisArg, v, k, this);
    }
  }
}

/**
 * Build a `ctx.query`-shaped object from a raw query string.
 *
 * Prefers {@link NativeQueryParams} over the native `queryPairs` parse (the
 * same pairs the compiled prelude uses — measured ~4× faster than
 * `new URLSearchParams(query)` on a 20-parameter query) and falls back to
 * `URLSearchParams` when the native surface is unavailable, so the parsed
 * shape degrades gracefully. Both expose the read-side contract handlers use
 * (`get`, `has`, `getAll`, `size`, iteration, `toString`, `forEach`);
 * mutation methods are not part of the request-path contract.
 *
 * @param queryString - The query string WITHOUT the leading `?`.
 */
export const createQueryParams = (queryString: string): NativeQueryParams | URLSearchParams => {
  if (isNativeAvailable()) {
    return new NativeQueryParams(queryPairs(queryString));
  }
  return new URLSearchParams(queryString);
};
