/**
 * @fileoverview Conditional requests (ETag / Last-Modified → 304).
 */

/** A per-resource conditional-request checker (etag + last-modified). */
export interface ConditionalRequest {
  /** `true` → "304 Not Modified" (If-None-Match wins over If-Modified-Since). */
  isNotModified(ifNoneMatch?: string | null, ifModifiedSince?: string | null): boolean;
}

/**
 * Compile a per-resource conditional-check instance (etag + last-modified
 * computed once, then reused across requests). Native-backed when available;
 * the fallback mirrors castrum's `ConditionalRequest` semantics exactly
 * (RFC 7232 §3.2 — weak opaque-tag comparison, `*` short-circuit, and
 * If-None-Match precedence over If-Modified-Since).
 */
export const createConditionalRequest = (
  etagValue: string,
  lastModifiedSecs?: number,
): ConditionalRequest =>
  // Selection: js — per-call native construction loses (~12x) — see selection.ts.
  createConditionalRequestFallback(etagValue, lastModifiedSecs);

/** Pure-TS fallback for {@link createConditionalRequest} (identical behavior). */
export const createConditionalRequestFallback = (
  etagValue: string,
  lastModifiedSecs?: number,
): ConditionalRequest => {
  const strong = etagValue.trim().replace(/^W\//, "");
  const weakEq = (tag: string): boolean => tag.trim().replace(/^W\//, "") === strong;
  const lastModified = Math.max(0, Math.floor(lastModifiedSecs ?? 0));
  return {
    isNotModified(ifNoneMatch, ifModifiedSince) {
      if (ifNoneMatch) {
        const header = ifNoneMatch.trim();
        if (header === "*") return true;
        return header.split(",").some((candidate) => weakEq(candidate));
      }
      if (lastModified > 0 && ifModifiedSince) {
        const secs = Date.parse(ifModifiedSince);
        if (!Number.isNaN(secs)) return lastModified <= Math.floor(secs / 1000);
      }
      return false;
    },
  };
};
