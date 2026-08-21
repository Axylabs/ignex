/**
 * @fileoverview Conditional requests (ETag / Last-Modified → 304).
 */

import { getFfiInstances } from "../ffi";
import { getNative } from "../loader";
import { toBytes } from "../util";

/** A per-resource conditional-request checker (etag + last-modified). */
export interface ConditionalRequest {
  /** `true` → "304 Not Modified" (If-None-Match wins over If-Modified-Since). */
  isNotModified(ifNoneMatch?: string | null, ifModifiedSince?: string | null): boolean;
}

/**
 * Compile a per-resource conditional-check instance (etag + last-modified
 * computed once, then reused across requests). Opaque-handle C-ABI fast path
 * (the resource state is compiled once via the napi instance; each 304 check
 * crosses at ~31ns vs ~42ns JS fallback and ~304ns NAPI — bench 2026-08-16).
 * Falls back to the pure-TS engine when the instance surface is absent.
 * (The OLD per-call native construction lost ~12x — the compiled instance is
 * what makes native win.)
 */
export const createConditionalRequest = (
  etagValue: string,
  lastModifiedSecs?: number,
): ConditionalRequest => {
  const ffiInst = getFfiInstances();
  if (ffiInst) {
    const addon = getNative();
    if (addon && typeof addon.ConditionalRequest === "function") {
      try {
        const inst = new addon.ConditionalRequest(toBytes(etagValue), lastModifiedSecs ?? null);
        const inner = Number(inst.innerPtr());
        if (inner) {
          return {
            isNotModified(ifNoneMatch, ifModifiedSince) {
              // C-ABI takes the headers as `cstring` ARGs (engine transcodes
              // in-engine — zero JS encode); absent headers pass `null` and
              // are gated by the presence flags on the Rust side.
              return ffiInst.conditionalIsNotModified(
                inner,
                ifNoneMatch ?? null,
                ifModifiedSince ?? null,
              );
            },
          };
        }
      } catch {
        // fall through to the JS engine
      }
    }
  }
  return createConditionalRequestFallback(etagValue, lastModifiedSecs);
};

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
