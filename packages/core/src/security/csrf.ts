/**
 * CSRF protection — double-submit cookie guard.
 *
 * `createCsrfGuard` issues a signed token cookie on the first visit and, for
 * state-changing methods, requires the client to echo it in a header. This is
 * both a double-submit check and an HMAC signature check (native-accelerated).
 */
import { csrfToken, csrfVerify } from "@ignex/native";
import type { IgnexContext } from "../http/context";
import { writeCookie } from "../http/cookies";
import { continueHook, type HookFn, haltHook } from "../lifecycle/hooks";
import type { HttpMethod } from "../types";

export { csrfToken, csrfVerify } from "@ignex/native";

/** Options for {@link createCsrfGuard}. */
export interface CsrfGuardOptions {
  secret: string | Uint8Array;
  cookieName?: string;
  headerName?: string;
  /** Methods protected by the guard (defaults to all state-changing ones). */
  methods?: readonly HttpMethod[];
  cookieOptions?: Partial<Record<string, unknown>>;
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

/** Create a double-submit CSRF guard hook. */
export const createCsrfGuard = (options: CsrfGuardOptions): HookFn => {
  const {
    secret,
    cookieName = "csrf-token",
    headerName = "x-csrf-token",
    methods = DEFAULT_METHODS,
    cookieOptions = { httpOnly: false, sameSite: "strict", path: "/" },
    ignore,
  } = options;

  return async (ctx) => {
    if (ignore?.(ctx)) return continueHook(ctx);

    // Ensure the client has a token cookie (set once, reused across requests).
    const existing = ctx.cookie[cookieName]?.value;
    if (!existing) {
      writeCookie(ctx.cookie, cookieName, csrfToken(secret), cookieOptions);
    }

    if (!methods.includes(ctx.method)) return continueHook(ctx);

    const cookie = ctx.cookie[cookieName]?.value;
    const header = ctx.headers.get(headerName);

    if (!cookie || !header || !safeEqual(header, cookie) || !csrfVerify(header, secret)) {
      return haltHook(Response.json({ error: "CSRF token validation failed" }, { status: 403 }));
    }

    return continueHook(ctx);
  };
};
