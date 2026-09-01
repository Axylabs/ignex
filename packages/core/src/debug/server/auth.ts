/**
 * @fileoverview Debugbar token gate — header/cookie authentication with a
 * constant-time compare and the one-time `?token=` → HttpOnly-cookie
 * handshake. Extracted from the plugin so the serving layer and the endpoint
 * table share one authorization implementation.
 */

import type { IgnexContext } from "../../http/context";

/** Path-scoped cookie established by the `?token=` page handshake. */
export const COOKIE_NAME = "__debugbar_token";

/** Length-safe constant-time string equality (byte-wise, UTF-8 chars). */
export const tokenEquals = (a: string | null | undefined, b: string): boolean => {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Authorization surface for the dashboard mount. */
export interface TokenGate {
  /** True when the request may access dashboard endpoints (no token = open). */
  authorized: (ctx: IgnexContext) => boolean;
  /** True when the PAGE request carries the token in its query string. */
  hasQueryToken: (ctx: IgnexContext) => boolean;
}

/** Build the gate for a mount (null token = no auth). */
export const createTokenGate = (token: string | null): TokenGate => ({
  authorized: (ctx): boolean => {
    if (!token) return true;
    if (tokenEquals(ctx.headers.get("x-debugbar-token"), token)) return true;
    const cookie = ctx.headers
      .get("cookie")
      ?.split(";")
      .map((pair) => pair.trim())
      .find((pair) => pair.startsWith(`${COOKIE_NAME}=`));
    return tokenEquals(cookie?.slice(COOKIE_NAME.length + 1), token);
  },
  hasQueryToken: (ctx): boolean =>
    token != null && tokenEquals(ctx.url.searchParams.get("token"), token),
});
