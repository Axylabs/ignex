/**
 * @fileoverview Request-framing conflict guard.
 *
 * HTTP request smuggling setup detection: a request carrying BOTH
 * `content-length` and a non-`chunked` `transfer-encoding` (or duplicate /
 * ambiguous framing values) is the classic CL.TE / TE.CL desynchronization
 * vector between a reverse proxy and the app server. Bun enforces a single
 * framing at the socket level; this pure guard lets the framework boundary
 * reject the setup too, so a proxy that forwards raw framing cannot smuggle a
 * second request past the app.
 *
 * Pure function of a `Headers` object — no I/O, no mutation.
 */

/** True when `comma`-separated values repeat, or a value is invalid. */
const splitAll = (value: string): string[] =>
  value.split(",").map((part) => part.trim().toLowerCase());

const parseContentLength = (value: string): number | null => {
  if (!/^\d+$/.test(value)) return null; // negative, empty, non-numeric
  return Number(value);
};

/**
 * Detect framing conflicts in `headers`.
 *
 * @param headers - The request headers (case-insensitive per the Headers API).
 * @returns A machine-readable reason string when the framing is ambiguous or
 *   contradictory, `null` when the request carries a single unambiguous
 *   framing signal (or none — a zero-length request).
 */
export const framingConflict = (headers: Headers): string | null => {
  const transferEncoding = headers.get("transfer-encoding");
  const contentLength = headers.get("content-length");

  // TE must be exactly `chunked` (single value). Anything else — `gzip`,
  // `identity`, `chunked, gzip`, empty — either contradicts CL (TE.CL) or is
  // the obfuscation a smuggler uses to defeat naive parsing.
  if (transferEncoding !== null && transferEncoding !== "") {
    const encodings = splitAll(transferEncoding);
    if (encodings.length !== 1 || encodings[0] !== "chunked") {
      return "transfer-encoding must be exactly 'chunked'";
    }
    if (contentLength !== null) return "both content-length and transfer-encoding present";
    return null;
  }

  if (contentLength !== null) {
    // The Headers API joins duplicate `content-length` values with ", " —
    // reject any repetition and any non-numeric value outright.
    const values = splitAll(contentLength);
    const single = values.length === 1 ? (values[0] as string | undefined) : undefined;
    if (single === undefined || parseContentLength(single) === null) {
      return "invalid content-length";
    }
    return null;
  }

  return null;
};

/**
 * Convenience predicate over {@link framingConflict}.
 *
 * @param headers - The request headers.
 * @returns `true` when the request carries a framing conflict.
 */
export const hasConflictingFraming = (headers: Headers): boolean =>
  framingConflict(headers) !== null;
