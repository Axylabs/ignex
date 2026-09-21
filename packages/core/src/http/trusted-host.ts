/**
 * @fileoverview Trusted-Host header validator.
 *
 * Host-header poisoning: an app that builds absolute URLs from the `Host`
 * header (password-reset links, OAuth callbacks, cache/purge keys, …) must
 * not trust it blindly — an attacker sets `Host: evil.com` and the app
 * happily emits attacker-controlled links. This small pure validator lets an
 * app check `ctx.headers.get("host")` against an explicit allowlist before
 * deriving anything from it.
 *
 * Matching rules:
 * - case-insensitive hostname comparison;
 * - allowlist entries may be `host` (matches that hostname on ANY port — the
 *   common proxied case) or `host:port` (matches exactly);
 * - IPv6 literals may appear bracketed or bare on the allowlist;
 * - control characters (CR/LF header injection), whitespace, and empty
 *   inputs are always deficient.
 */

/** Allowlist options for {@link trustedHost}. */
export interface TrustedHostOptions {
  /**
   * Hostnames (and optional ports) the `Host` header must match. Entries are
   * literal: no wildcards (`*.example.com` is NOT accepted).
   */
  readonly allowlist: readonly string[];
}

const CONTROL_CHARS = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
};

/** Split `authority` into hostname + optional port (IPv6-bracket aware). */
const splitAuthority = (value: string): { host: string; port: string | null } => {
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1) return { host: value.toLowerCase(), port: null };
    const rest = value.slice(close + 1);
    return {
      // Compare the literal inside the brackets — the allowlist author may
      // write `::1` or `[::1]`; both mean the same origin.
      host: value.slice(1, close).toLowerCase(),
      port: rest.startsWith(":") ? rest.slice(1) : null,
    };
  }
  const colon = value.lastIndexOf(":");
  // More than one colon and no bracket = an unbracketed IPv6 literal
  // (`::1`, `fe80::1`) — never a host:port split.
  if (colon === -1 || value.indexOf(":") !== colon) {
    return { host: value.toLowerCase(), port: null };
  }
  return { host: value.slice(0, colon).toLowerCase(), port: value.slice(colon + 1) };
};

/**
 * True when `host` (the raw `Host` header value) matches the allowlist.
 *
 * @param host - The `Host` header value, or `null`/`undefined` when absent.
 * @param options - The allowlist.
 * @returns `false` for deficient input, header injection, or any hostname that
 *   fails the literal (case/port-normalized) allowlist match.
 */
export const trustedHost = (
  host: string | null | undefined,
  options: TrustedHostOptions,
): boolean => {
  if (host === null || host === undefined || host === "") return false;
  if (CONTROL_CHARS(host)) return false;
  if (/\s/.test(host)) return false;
  if (host.startsWith(".") || host.endsWith(".")) return false;

  const incoming = splitAuthority(host);
  for (const entryRaw of options.allowlist) {
    const entry = splitAuthority(entryRaw);
    if (entry.host !== incoming.host) continue;
    // Entry without a port matches any port; with a port, the incoming port
    // must be exactly equal.
    if (entry.port === null) return true;
    if (incoming.port !== null && entry.port === incoming.port) return true;
  }
  return false;
};
