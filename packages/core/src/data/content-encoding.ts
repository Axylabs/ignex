/**
 * @fileoverview Content-Encoding helpers — pure functions for compression
 * decisions: Accept-Encoding negotiation (q-values + wildcard), content-type
 * compressibility, and variant ETag suffixing. No I/O, no timers — unit-
 * testable in isolation and shared by the compression plugin.
 */

import { parseAcceptEncoding } from "@ignex/native";

/** Content-type prefixes that are safe to compress (text-like, not media). */
const COMPRESSIBLE_PREFIXES = [
  "text/",
  "application/json",
  "application/javascript",
  "application/xml",
  "image/svg+xml",
] as const;

/** Whether a `Content-Type` value is a compressible representation. */
export const isCompressible = (contentType: string): boolean =>
  COMPRESSIBLE_PREFIXES.some((prefix) => contentType.startsWith(prefix));

/**
 * Negotiate the best supported content-coding from an `Accept-Encoding`
 * header. Respects explicit `q` weights and `q=0` exclusions, and applies a
 * wildcard `*` entry to supported encodings not listed explicitly. On equal
 * weight, the caller's `supported` order (server preference) decides. Returns
 * `null` when no supported encoding is acceptable (or the header is absent).
 *
 * Examples:
 * - `"gzip, br"`            → `"br"` (tie broken by server preference)
 * - `"br;q=0.8, gzip;q=0.9"` → `"gzip"`
 * - `"gzip;q=0, deflate"`   → `"deflate"` (gzip excluded)
 * - `"*"`                   → first supported encoding
 * - `"identity"`            → `null` (no supported encoding acceptable)
 */
export const negotiateEncoding = (header: string, supported: readonly string[]): string | null => {
  if (!header) return null;

  const prefs = parseAcceptEncoding(header);
  if (prefs.length === 0) return null;

  const explicit = new Map<string, number>();
  const listed: string[] = [];
  let wildcardQ = -1; // -1 = no wildcard present

  for (const { encoding, q } of prefs) {
    if (encoding === "*") {
      wildcardQ = Math.max(wildcardQ, q);
      continue;
    }
    // Duplicate encodings are undefined by RFC 7231; first occurrence wins.
    if (!explicit.has(encoding)) {
      explicit.set(encoding, q);
      listed.push(encoding);
    }
  }

  const qFor = (enc: string): number => {
    if (explicit.has(enc)) return explicit.get(enc) ?? -1;
    return wildcardQ >= 0 ? wildcardQ : -1;
  };

  let best: string | null = null;
  let bestQ = -1;

  for (const enc of supported) {
    const q = qFor(enc);
    if (q <= 0) continue; // q=0 → explicitly not acceptable
    if (q > bestQ) {
      best = enc;
      bestQ = q;
    }
    // Ties keep the earlier `supported` entry (server preference).
  }

  return best;
};

/**
 * Rewrite an ETag so it identifies the *content-coded* variant. Compressing a
 * body produces a distinct representation, so strong validators must differ
 * (RFC 7232). Appends `-<encoding>` inside the quotes, preserving the weak
 * prefix: `"abc"` + gzip → `"abc-gzip"`, `W/"abc"` + br → `W/"abc-br"`.
 */
export const etagWithEncoding = (etagValue: string, encoding: string): string => {
  const weak = etagValue.startsWith("W/");
  const inner = weak ? etagValue.slice(3) : etagValue.slice(1);
  const body = inner.endsWith('"') ? inner.slice(0, -1) : inner;
  return `${weak ? "W/" : ""}"${body}-${encoding}"`;
};
