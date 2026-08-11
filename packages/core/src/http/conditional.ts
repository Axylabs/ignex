/**
 * @fileoverview Conditional-request helpers (ETag / If-Modified-Since).
 *
 * Single source of truth for the `if-none-match` / `if-modified-since`
 * checks — previously inlined in `data/cache.ts` (browser cache + response
 * cache) and `http/files.ts`. Semantics follow RFC 7232 §3.2: If-None-Match
 * wins over If-Modified-Since, and opaque-tag comparison is weak
 * (`W/` prefix ignored). When the Rust addon is present, the check is
 * delegated to castrum's compiled `ConditionalRequest` (304 fast path);
 * otherwise the `@ignus/native` fallback implements byte-identical semantics.
 */

import { createConditionalRequest } from "@ignus/native";

/** `true` when the request's preconditions match the given entity tags/dates. */
export const isNotModified = (req: Request, etag?: string, lastModified?: string): boolean => {
  const inm = req.headers.get("if-none-match");
  const ims = req.headers.get("if-modified-since");

  if (etag) {
    // Both the native `ConditionalRequest` and its pure-TS fallback share
    // RFC 7232 semantics, so behavior is identical with or without the addon.
    const lastModifiedSecs = lastModified ? Math.floor(Date.parse(lastModified) / 1000) : undefined;
    return createConditionalRequest(etag, lastModifiedSecs).isNotModified(inm, ims);
  }

  if (lastModified && ims && new Date(ims).getTime() >= new Date(lastModified).getTime()) {
    return true;
  }

  return false;
};
