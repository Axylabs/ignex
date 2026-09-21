/**
 * @fileoverview Safe-capture helpers for debug traces: header redaction and
 * body clipping. Pure functions on plain data — no state, no IO — so the
 * dashboard wire never receives sensitive header values or unbounded bodies.
 */

const REDACTED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-debugbar-token",
]);

/** Redact sensitive header values while preserving names. */
export const redactHeaderValue = (name: string): string =>
  REDACTED_HEADERS.has(name.toLowerCase()) ? "[redacted]" : "";

/** True when the header value must never be captured. */
export const isRedactedHeader = (name: string): boolean => REDACTED_HEADERS.has(name.toLowerCase());

/** Build a redacted header record from a Headers instance. */
export const captureRedactedHeaders = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  headers.forEach((value, key) => {
    out[key] = isRedactedHeader(key) ? "[redacted]" : value;
  });
  return out;
};

/**
 * Capture cap for request/response bodies (UTF-16 code units ≈ bytes for
 * ASCII payloads). Dev-toolbar tradeoff: big enough for realistic JSON
 * fixtures, small enough that a stray huge upload cannot balloon the ring.
 */
export const MAX_CAPTURED_BODY_CHARS = 262_144; // 256 KiB

/** Clip a captured body to the cap; returns the text plus a truncated flag. */
export const clipBody = (text: string): { text: string; truncated: boolean } =>
  text.length > MAX_CAPTURED_BODY_CHARS
    ? { text: text.slice(0, MAX_CAPTURED_BODY_CHARS), truncated: true }
    : { text, truncated: false };
