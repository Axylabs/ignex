/**
 * @fileoverview Open-redirect guard for redirect targets.
 *
 * `Response` `Location` values are trusted by browsers almost verbatim, so a
 * route that redirects to a user-influenced target (a `?next=` param, a
 * Referer-derived URL, …) must never echo it unchanged: `javascript:`,
 * `data:`, protocol-relative `//evil.com`, backslash confusion and CR/LF
 * header injection are all real open-redirect / XSS vectors on the wire.
 *
 * This module is a pure classifier over the raw target string — it never
 * constructs a `URL` on hostile input (URL parsers tolerate characters that
 * strict routing must reject) and performs no I/O. {@link ctx redirect()} on
 * the context and the generated route surface call
 * {@link assertSafeRedirectTarget} before writing `Location`.
 */

import { HTTPError } from "../platform/errors";

/**
 * 400 Bad Request — the redirect target failed the open-redirect guard.
 *
 * `reason` carries the classification ("unsafe scheme", "protocol-relative",
 * "control chars", …) so middleware/tests can react without parsing messages.
 */
export class UnsafeRedirectError extends HTTPError {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(400, message, "UNSAFE_REDIRECT", { reason });
    this.name = "UnsafeRedirectError";
  }
}

/** Classification of one target string. */
export type RedirectTarget = { kind: "ok"; target: string } | { kind: "unsafe"; reason: string };

/** Guard options. */
export interface RedirectGuardOptions {
  /**
   * Permit protocol-relative targets (`//host/path`). Off by default —
   * protocol-relative URLs let an attacker pick the scheme, so they are a
   * confusion vector even when the hostname is safe.
   */
  allowExternal?: boolean;
}

const MT = String.raw`[A-Za-z][A-Za-z0-9+.\-]*`;
const SCHEME_RE = new RegExp(`^(${MT}):`);
const ABSOLUTE_HTTP_RE = /^https?:\/\/[^/]/i;
const LEADING_WS_RE = /^\s/;

/** True when the string contains any ASCII control character (incl. CR/LF). */
const hasControlChars = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
};

/** Schemes this guard ever lets through (case-insensitive). */
const HTTP_SCHEMES = new Set(["http", "https"]);

const unsafe = (reason: string): RedirectTarget => ({ kind: "unsafe", reason });
const ok = (target: string): RedirectTarget => ({ kind: "ok", target });

/**
 * Classify a redirect target string as safe (relative path / absolute
 * http(s)) or unsafe (arbitrary scheme, protocol-relative without
 * `allowExternal`, control chars, backslash confusion, missing authority).
 *
 * @param url - The raw `Location` value, exactly as the app wants to emit it.
 * @param options - Guard tuning (see {@link RedirectGuardOptions}).
 * @returns Safe or unsafe with a machine-readable reason.
 */
export const checkRedirectTarget = (
  url: string,
  options: RedirectGuardOptions = {},
): RedirectTarget => {
  if (url === "") return unsafe("empty target");
  if (hasControlChars(url)) return unsafe("control chars");
  if (LEADING_WS_RE.test(url)) return unsafe("leading whitespace");
  if (url.startsWith("\\")) return unsafe("backslash confusion");

  const schemeMatch = SCHEME_RE.exec(url);
  const scheme = schemeMatch?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (HTTP_SCHEMES.has(scheme)) {
      // Strict authority: scheme:// must be followed by a non-slash (a real
      // host). `https:///path` and `http:evil.com` fail here.
      if (!ABSOLUTE_HTTP_RE.test(url)) return unsafe("missing authority");
      return ok(url);
    }
    // javascript:, data:, vbscript:, file:, … — never allowed, even with
    // allowExternal (no scheme escape hatch).
    return unsafe("non-http scheme");
  }

  // No scheme: path-relative or empty-ish. `//` (including `///`) means
  // protocol-relative in every browser — a scheme confusion vector.
  if (url.startsWith("//")) {
    if (options.allowExternal === true) return ok(url);
    return unsafe("protocol-relative");
  }

  return ok(url);
};

/**
 * Assert `url` is a safe redirect target and return it unchanged, throwing
 * {@link UnsafeRedirectError} (HTTP 400) otherwise.
 *
 * @param url - The raw `Location` value.
 * @param options - Guard tuning (see {@link RedirectGuardOptions}).
 * @returns The untouched target, ready for the `Location` header.
 * @throws {@link UnsafeRedirectError} when classification fails.
 */
export const assertSafeRedirectTarget = (url: string, options?: RedirectGuardOptions): string => {
  const result = checkRedirectTarget(url, options);
  if (result.kind === "unsafe") {
    throw new UnsafeRedirectError(`unsafe redirect target: ${result.reason}`, result.reason);
  }
  return result.target;
};
