/**
 * @fileoverview The error envelope — the client-visible shape of a failure.
 *
 * This is the "what may leave the process" half of the error system, kept apart
 * from the error classes themselves (`http-errors.ts`) so the exposure policy is
 * readable in one place:
 *
 * - **Headers** — {@link JSON_HEADERS} carries the core security posture, so an
 *   error page is never frameable or MIME-sniffable.
 * - **Bodies** — {@link cachedErrorBody} memoizes the deterministic
 *   `{ error, status, code }` JSON for repeated statuses.
 * - **Messages** — {@link genericStatusMessage} is the canonical reason phrase
 *   used whenever the real message is operator-only (every 5xx unless exposed).
 *
 * The rule this file implements: a client gets a status, a stable code and a
 * canonical reason phrase — never a driver string, a host, or a query.
 * `ErrorExposureOptions.expose` is the only door out of that policy, and only
 * outside production (see `docs/errors.md`).
 */

/**
 * Shared JSON content-type header for error envelopes (no per-call alloc).
 *
 * Error envelopes always carry the core security posture (frame protection,
 * no-sniff, referrer policy) so they match the OK-path `security()` plugin and
 * the Rust ingress pipeline's pre-baked terminal templates — error pages are
 * never frameable or MIME-sniffable even if an app disables the header plugin.
 */
export const JSON_HEADERS: Record<string, string> = Object.freeze({
  "content-type": "application/json",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});

/** Memoized error-envelope JSON bodies keyed by `status|code|message`. */
const bodyCache = new Map<string, string>();
const BODY_CACHE_MAX = 64;

/**
 * Deterministic envelope JSON for `status|code|message`, memoized (repeated
 * error envelopes are the common case and skip `JSON.stringify` + allocation).
 */
export const cachedErrorBody = (
  status: number,
  code: string | undefined,
  message: string,
): string => {
  const key = `${status}|${code ?? ""}|${message}`;
  const hit = bodyCache.get(key);
  if (hit !== undefined) return hit;
  const body = JSON.stringify({ error: message, status, code });
  if (bodyCache.size >= BODY_CACHE_MAX) {
    const first = bodyCache.keys().next().value;
    if (first !== undefined) bodyCache.delete(first);
  }
  bodyCache.set(key, body);
  return body;
};

/** Whether an envelope should expose the real message + details. */
export interface ErrorExposureOptions {
  /**
   * Force the real message (redacted) and `details` into the envelope — the
   * `exposeErrors` / development path. Applies to 5xx too.
   */
  expose?: boolean;
}

/**
 * Canonical reason phrases a non-exposed message falls back to.
 *
 * Written out rather than read from `Response.statusText`, which is the EMPTY
 * string unless a server supplied one (a constructed `new Response(null, {
 * status })` carries none) — the earlier lookup silently produced "Request
 * failed" for every status, including 500.
 */
const STATUS_TEXT: Readonly<Record<number, string>> = Object.freeze({
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  412: "Precondition Failed",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  507: "Insufficient Storage",
});

/** Memoized generic messages (bounded: the status set above, plus two fallbacks). */
const GENERIC_MESSAGES = new Map<number, string>();

/**
 * The generic message a client gets when the real one is operator-only — the
 * canonical reason phrase for the status (`"Internal Server Error"` for 500,
 * `"Service Unavailable"` for 503). Never an internal detail.
 *
 * @param status - The HTTP status being answered with.
 * @returns The canonical reason phrase (an unknown 5xx → `"Internal Server Error"`).
 */
export const genericStatusMessage = (status: number): string => {
  const hit = GENERIC_MESSAGES.get(status);
  if (hit !== undefined) return hit;
  const message =
    STATUS_TEXT[status] ?? (status >= 500 ? "Internal Server Error" : "Request failed");
  GENERIC_MESSAGES.set(status, message);
  return message;
};
