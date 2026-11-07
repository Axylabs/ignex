/**
 * CSRF protection — double-submit cookie guard with Origin enforcement.
 *
 * `createCsrfGuard` issues a signed token cookie on the first visit and, for
 * state-changing methods, requires the client to echo it in a header. This is
 * both a double-submit check and an HMAC signature check (native-accelerated).
 *
 * Defense-in-depth layers (since the hardening pass):
 *  - **Origin check** (default `"same-origin"`): when the browser sends an
 *    `Origin` (or `Referer`) header on a state-changing request, it must match
 *    the request's own origin or the explicit allowlist — cross-site posts
 *    are rejected even if a subdomain ever leaks a token cookie.
 *  - **Session binding** (`bindSession`): when a session cookie is present,
 *    the verify key is derived as HMAC(secret, sid), so a token issued to one
 *    session cannot be replayed under another.
 *  - **`__Host-` prefix** (`hostPrefix`): cookie name gets the `__Host-`
 *    prefix with `secure: true, path: "/"` forced (browser-observable
 *    guarantees: the cookie is never sent to sibling subdomains).
 */
import { csrfToken, csrfVerify, hmacSha256 } from "@ignex/native";
import type { IgnexContext } from "../http/context";
import { writeCookie } from "../http/cookies";
import { continueHook, type HookFn, haltHook } from "../lifecycle/hooks";
import type { HttpMethod } from "../types";
import { normalizeSecrets, type SecretInput, signSecret, verifyBoolWithRing } from "./keyring";

/** Origin enforcement mode for {@link CsrfGuardOptions.origin}. */
export type CsrfOriginMode = "same-origin" | readonly string[] | false;

/** Options for {@link createCsrfGuard}. */
export interface CsrfGuardOptions {
  /** HMAC key — or a rotation ring (current first, previous after). */
  secret: SecretInput;
  cookieName?: string;
  headerName?: string;
  /** Methods protected by the guard (defaults to all state-changing ones). */
  methods?: readonly HttpMethod[];
  cookieOptions?: Partial<Record<string, unknown>>;
  /**
   * Origin enforcement: `"same-origin"` (default) requires a present
   * `Origin`/`Referer` to match the request's own origin; an array is an
   * explicit allowlist of additional accepted origins (scheme+host, e.g.
   * `https://www.example.com`); `false` disables the check (token-only).
   */
  origin?: CsrfOriginMode;
  /**
   * Bind tokens to the session: when a session cookie is present, the verify
   * key is derived as HMAC(secret, sid) — tokens are not replayable across
   * sessions. Set to the session cookie name (e.g. `"sid"`).
   */
  bindSession?: string | false;
  /**
   * Use a `__Host-${cookieName}` cookie with `secure: true, path: "/"`
   * forced — the browser then never sends the token cookie to sibling
   * subdomains, closing double-submit cookie-injection variants.
   */
  hostPrefix?: boolean;
  /** Skip the guard for matching requests (e.g. public webhooks). */
  ignore?: (ctx: IgnexContext) => boolean;
}

const DEFAULT_METHODS: readonly HttpMethod[] = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * Length-checked constant-time string equality for the double-submit compare.
 * The HMAC inside {@link csrfVerify} is already constant-time, but the
 * cookie↔header equality itself must be too — a plain `!==` leaks the
 * matched-prefix length to a same-origin script reading response timing.
 */
const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** `scheme://host` of the request URL (the origin the server itself saw). */
const requestOrigin = (ctx: IgnexContext): string | null => {
  try {
    const url = new URL(ctx.req.url);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
};

/** `scheme://host` of an Origin/Referer header value, or `null` when absent/malformed. */
const headerOrigin = (value: string | null): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
};

/** Session-bound verify key: HMAC(secret, sid) — hex, per ring entry. */
const sessionBoundSecrets = (secrets: readonly (string | Uint8Array)[], sid: string) =>
  secrets
    .map((entry) => Buffer.from(hmacSha256(Buffer.from(entry), Buffer.from(sid))))
    .map((bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));

/** Create a double-submit CSRF guard hook. */
export const createCsrfGuard = (options: CsrfGuardOptions): HookFn => {
  const {
    secret,
    cookieName = "csrf-token",
    headerName = "x-csrf-token",
    methods = DEFAULT_METHODS,
    cookieOptions = { httpOnly: false, sameSite: "strict", path: "/" },
    origin = "same-origin",
    bindSession = false,
    hostPrefix = false,
    ignore,
  } = options;
  const secrets = normalizeSecrets(secret);
  const effectiveCookieName = hostPrefix ? `__Host-${cookieName}` : cookieName;
  const effectiveCookieOptions = hostPrefix
    ? { ...cookieOptions, secure: true, path: "/" }
    : cookieOptions;
  const allowList = origin === "same-origin" || origin === false ? null : origin;

  /** Verify key ring: session-derived when a session cookie is present. */
  const verifyKeys = (ctx: IgnexContext): readonly (string | Uint8Array)[] => {
    if (bindSession === false) return secrets;
    const sid = ctx.cookie[bindSession]?.value;
    return sid ? sessionBoundSecrets(secrets, sid) : secrets;
  };

  /**
   * Origin layer: `true` = pass (or nothing to check), `false` = reject.
   * Only state-changing requests with a browser-supplied Origin/Referer are
   * checked; header-less clients (curl, server-to-server) fall through to
   * the token layer unchanged.
   */
  const originAllowed = (ctx: IgnexContext): boolean => {
    if (origin === false) return true;
    const presented =
      headerOrigin(ctx.headers.get("origin")) ?? headerOrigin(ctx.headers.get("referer"));
    if (presented === null) return true;
    const own = requestOrigin(ctx);
    if (own !== null && safeEqual(presented.toLowerCase(), own.toLowerCase())) return true;
    if (allowList !== null) {
      return allowList.some(
        (allowed) => headerOrigin(allowed)?.toLowerCase() === presented.toLowerCase(),
      );
    }
    return false;
  };

  return async (ctx) => {
    if (ignore?.(ctx)) return continueHook(ctx);

    // Ensure the client has a token cookie (set once, reused across requests).
    // Minted with the SAME key derivation verification uses, so a
    // session-bound deployment mints bound tokens when a session exists.
    const existing = ctx.cookie[effectiveCookieName]?.value;
    if (!existing) {
      const mintKey = verifyKeys(ctx)[0] ?? signSecret(secrets);
      writeCookie(ctx.cookie, effectiveCookieName, csrfToken(mintKey), effectiveCookieOptions);
    }

    if (!methods.includes(ctx.method)) return continueHook(ctx);

    if (!originAllowed(ctx)) {
      return haltHook(Response.json({ error: "CSRF origin validation failed" }, { status: 403 }));
    }

    const cookie = ctx.cookie[effectiveCookieName]?.value;
    const header = ctx.headers.get(headerName);
    const keys = verifyKeys(ctx);

    const valid =
      cookie !== undefined &&
      header !== null &&
      safeEqual(header, cookie) &&
      verifyBoolWithRing(keys, (entry) => csrfVerify(header, entry));
    if (!valid) {
      return haltHook(Response.json({ error: "CSRF token validation failed" }, { status: 403 }));
    }

    return continueHook(ctx);
  };
};
