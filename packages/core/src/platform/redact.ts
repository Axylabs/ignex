/**
 * @fileoverview Log-safe text helpers — credential masking and line clipping.
 *
 * Fault reports, boot reports and debug traces quote text that came from
 * drivers, network peers and configuration. That text routinely carries
 * credentials (`mongodb://user:pass@host`, `?token=…`, `password=…`), so every
 * string that reaches a log line, a report or a crash message is passed through
 * {@link redactLogText} — a password must never be captured by a log scraper or
 * pasted into a bug report.
 *
 * Masking is deliberately textual (not field-aware): it cannot know which key
 * is a secret, so it masks the well-known shapes — URL userinfo and
 * `secret=<value>` pairs — and clips everything to one readable line.
 */

/** `scheme://user:secret@host` — the password is the masked part. */
const CONNECTION_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):[^/\s@]*@/gi;

/** `password=…` / `token=…` / `api-key=…` pairs (query strings, log fields). */
const SECRET_PAIR =
  /\b(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key)=([^&\s;,"')]+)/gi;

/** Default clip width for one report line. */
export const MAX_LOG_LINE = 240;

/** Mask the password of `scheme://user:secret@host` connection strings. */
export const maskCredentials = (value: string): string =>
  value.replace(CONNECTION_CREDENTIALS, "$1:***@");

/** Mask `password=…` / `token=…` style secret pairs. */
export const maskSecretPairs = (value: string): string => value.replace(SECRET_PAIR, "$1=***");

/** Collapse a value to its first non-empty line and clip it to `max`. */
export const clipLine = (value: string, max = MAX_LOG_LINE): string => {
  const single = (value.split("\n").find((line) => line.trim().length > 0) ?? "").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
};

/**
 * Make a quoted message safe to log: mask credentials and secret pairs,
 * collapse to one line, clip to `max` characters.
 *
 * @param value - The raw text (a driver message, a connection string, …).
 * @param max - Maximum line length (default {@link MAX_LOG_LINE}).
 * @returns The redacted, single-line text.
 */
export const redactLogText = (value: string, max = MAX_LOG_LINE): string =>
  clipLine(maskSecretPairs(maskCredentials(value)), max);
