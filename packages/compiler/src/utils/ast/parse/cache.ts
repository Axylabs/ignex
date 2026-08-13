/**
 * @fileoverview Parse memoization — content-keyed bounded cache.
 *
 * The same module is parsed up to 5× per build (discovery, analysis,
 * constant-response detection, inlining eligibility, inline-candidate
 * extraction) and every extracted field is a pure function of `source`, so a
 * single cached {@link ParseResult} per source content is safe.
 */

import type { ParseResult } from "./types";

const PARSE_CACHE_MAX = 512;
const parseCache = new Map<string, ParseResult>();

export const cacheParse = (key: string, result: ParseResult): ParseResult => {
  parseCache.set(key, result);
  if (parseCache.size > PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  return result;
};

export const getCachedParse = (key: string): ParseResult | undefined => parseCache.get(key);

/** Clear the in-process parse cache (mostly for tests / watch restarts). */
export const clearParseCache = (): void => {
  parseCache.clear();
};
