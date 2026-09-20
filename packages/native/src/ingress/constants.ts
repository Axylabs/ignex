/**
 * @fileoverview Shared constants for the direct C-ABI ingress pipeline —
 * the method-kind enum, output-buffer sizing, and the shared empty byte views.
 *
 * Extracted from the pre-split `ingress.ts` (move-only).
 */

/** HTTP method → native ingress method-kind enum (shared.ts). */
export const METHOD_KIND: Record<string, number> = {
  GET: 0,
  HEAD: 1,
  POST: 2,
  PUT: 3,
  PATCH: 4,
  DELETE: 5,
  OPTIONS: 6,
};
export const METHOD_KIND_UNKNOWN = 7;

/** Default ingress output-buffer size (bytes) — pooled per instance. */
export const DEFAULT_OUTPUT_BUFFER_SIZE = 131_072;
/** Absolute cap on the ingress output buffer (matches castrum). */
export const MAX_OUTPUT_BUFFER_SIZE = 64 * 1024 * 1024;

export const U32_MAX = 4_294_967_295; // castrum's "rate limiting disabled" sentinel

export const EMPTY_RID = new Uint8Array(0);
/** Shared immutable empty body view for pooled OK results (never mutated). */
export const EMPTY_BYTES = new Uint8Array(0);
