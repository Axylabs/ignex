/**
 * @fileoverview Content-Encoding helpers — pure functions for compression
 * decisions: Accept-Encoding negotiation (q-values + wildcard), content-type
 * compressibility, and variant ETag suffixing. No I/O, no timers — unit-
 * testable in isolation and shared by the compression plugin.
 */

import { type AcceptNegotiator, createAcceptNegotiator, parseAcceptEncoding } from "@ignex/native";

/** Content-type prefixes that are safe to compress (text-like, not media). */
const COMPRESSIBLE_PREFIXES = [
  "text/",
  "application/json",
  "application/javascript",
  "application/xml",
  "image/svg+xml",
] as const;

/**
 * Content types that must NEVER be compressed, even when they match a
 * compressible prefix. `text/event-stream` matches bare `text/` but its
 * semantics (an unbounded push channel) break under content-encoding, and
 * buffering one for compression is a memory-exhaustion hazard.
 */
const INCOMPRESSIBLE_TYPES = ["text/event-stream"] as const;

/** Whether a `Content-Type` value is a compressible representation. */
export const isCompressible = (contentType: string): boolean =>
  !INCOMPRESSIBLE_TYPES.some((type) => contentType.startsWith(type)) &&
  COMPRESSIBLE_PREFIXES.some((prefix) => contentType.startsWith(prefix));

/**
 * The compression plugin's `supported` lists are fixed per process (brotli
 * support is detected once), so the compiled native negotiator is cached per
 * list — `createAcceptNegotiator` compiles the supported values into a Rust
 * instance once (the intended "compiled negotiator" contract; per-request
 * construction measured ~0.5×). The key is the joined list so the brotli and
 * no-brotli variants each compile exactly once.
 */
const negotiatorCache = new Map<string, AcceptNegotiator | null>();
const negotiatorFor = (supported: readonly string[]): AcceptNegotiator | null => {
  const key = supported.join(",");
  let neg = negotiatorCache.get(key);
  if (neg === undefined) {
    // Falls back to the pure-TS engine when native is unavailable — the
    // returned instance always implements `negotiateServerPreference`.
    neg = createAcceptNegotiator([...supported]);
    negotiatorCache.set(key, neg);
  }
  return neg;
};

/**
 * Negotiate the best supported content-coding from an `Accept-Encoding`
 * header. Respects explicit `q` weights and `q=0` exclusions, and applies a
 * wildcard `*` entry to supported encodings not listed explicitly. On equal
 * weight, the caller's `supported` order (server preference) decides. Returns
 * `null` when no supported encoding is acceptable (or the header is absent).
 *
 * Native-first: the compiled Rust negotiator's `negotiateServerPreference`
 * implements EXACTLY this q-only / server-preference semantic (measured ~2.2×
 * vs the JS path), with the pure-TS engine as the fallback when the addon is
 * absent — byte-identical results either way.
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

  // Native path (compiled once): q-only server-preference semantics.
  const neg = negotiatorFor(supported);
  if (neg) return neg.negotiateServerPreference(header);

  // Pure-TS fallback — identical semantics (native absent).
  return negotiateEncodingJs(header, supported);
};

/** Pure-TS `negotiateEncoding` (the native negotiator's byte-identical twin). */
const negotiateEncodingJs = (header: string, supported: readonly string[]): string | null => {
  const prefs = parseAcceptEncoding(header);
  if (prefs.length === 0) return null;

  const explicit = new Map<string, number>();
  let wildcardQ = -1; // -1 = no wildcard present

  for (const { encoding, q } of prefs) {
    if (encoding === "*") {
      wildcardQ = Math.max(wildcardQ, q);
      continue;
    }
    // Duplicate encodings are undefined by RFC 7231; first occurrence wins.
    if (!explicit.has(encoding)) {
      explicit.set(encoding, q);
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
