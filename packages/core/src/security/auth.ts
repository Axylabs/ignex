/**
 * Authentication middleware — higher-order hooks.
 *
 * Composable with the hook engine (`composeHooks`, `continueHook`, `haltHook`).
 * Each factory returns a `HookFn` that resolves a user onto `ctx.state` (via
 * {@link getUser}/{@link setUser}) or halts with a 401.
 */
import type { IgnexContext } from "../http/context";
import { continueHook, type HookFn, haltHook } from "../lifecycle/hooks";
import type { MaybePromise } from "../types";
import { createJwt, type JwtServiceOptions } from "./crypto";

/** Key under which the resolved user is stored on `ctx.state`. */
export const USER_KEY = Symbol.for("ignex.user");

/** The authenticated user shape stored on `ctx.state` (an arbitrary record). */
export type AuthUser = Record<string, unknown>;

/** Read the authenticated user from a context. */
export const getUser = <T = AuthUser>(ctx: IgnexContext): T | undefined =>
  ctx.getState<T>(USER_KEY);

/** Attach the authenticated user to a context. */
export const setUser = (ctx: IgnexContext, user: unknown): void => ctx.setState(USER_KEY, user);

/**
 * Build a 401 JSON response, optionally with a `WWW-Authenticate` challenge.
 */
export const unauthorized = (challenge?: string): Response => {
  const headers: Record<string, string> = {};
  if (challenge) headers["www-authenticate"] = challenge;
  return Response.json({ error: "Unauthorized" }, { status: 401, headers });
};

/**
 * Build a 403 JSON response — the authenticated user is present but lacks the
 * required role/permission (RBAC guards).
 */
export const forbidden = (message = "Forbidden"): Response =>
  Response.json({ error: message }, { status: 403 });

/**
 * Shared user-resolution flow behind `requireAuth` / `optionalAuth`: extract
 * a user, attach it to `ctx.state`, and optionally halt with a 401 when it is
 * absent.
 */
const authFlow =
  <T>(extract: (ctx: IgnexContext) => MaybePromise<T | null>, required: boolean): HookFn =>
  async (ctx) => {
    const user = await extract(ctx);
    if (user == null) {
      if (required) return haltHook(unauthorized());
      return continueHook(ctx);
    }
    setUser(ctx, user);
    return continueHook(ctx);
  };

/**
 * Halt unless a user can be extracted. On success the user is attached to
 * `ctx.state`; on failure the request is halted with a 401.
 */
export const requireAuth = <T>(extract: (ctx: IgnexContext) => MaybePromise<T | null>): HookFn =>
  authFlow<T>(extract, true);

/**
 * Attach a user when one can be extracted, but never halt — for endpoints
 * that work for guests and authenticated users alike.
 */
export const optionalAuth = <T>(extract: (ctx: IgnexContext) => MaybePromise<T | null>): HookFn =>
  authFlow<T>(extract, false);

/** Split an `Authorization` header into its (lowercased) scheme + credentials. */
const parseAuthorizationHeader = (ctx: IgnexContext): { scheme: string; credentials: string } => {
  const header = ctx.headers.get("authorization") ?? "";
  const space = header.indexOf(" ");
  const scheme = space < 0 ? header : header.slice(0, space);
  const credentials = space < 0 ? "" : header.slice(space + 1);

  return { scheme: scheme.toLowerCase(), credentials };
};

/**
 * Shared scheme-based auth skeleton behind `basicAuth` / `bearerAuth`: parse
 * the `Authorization` header, require the expected `scheme`, verify the raw
 * credentials, attach the resulting user, and halt with a 401 challenge on
 * any failure.
 */
const schemeAuth =
  <T>(
    scheme: "basic" | "bearer",
    challenge: string | undefined,
    verify: (credentials: string, ctx: IgnexContext) => MaybePromise<T | null>,
  ): HookFn =>
  async (ctx) => {
    const { scheme: actual, credentials } = parseAuthorizationHeader(ctx);
    if (actual !== scheme || !credentials) return haltHook(unauthorized(challenge));
    const user = await verify(credentials, ctx);
    if (user == null) return haltHook(unauthorized(challenge));
    setUser(ctx, user);
    return continueHook(ctx);
  };

/** Strict base64 validation — `Buffer.from(s, "base64")` is LENIENT (it
 * decodes whatever it can and ignores invalid characters), so a malformed
 * credential would silently decode. Fail closed instead: only accept the
 * standard base64 alphabet with at most two trailing `=` pads and a length
 * that cannot be misaligned (unpadded length % 4 !== 1). */
const isStrictBase64 = (s: string): boolean => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return false;
  return s.replace(/=+$/, "").length % 4 !== 1;
};

/** Parse + verify HTTP Basic credentials (`Authorization: Basic base64(u:p)`). */
export const basicAuth = (
  verify: (username: string, password: string, ctx: IgnexContext) => MaybePromise<unknown | null>,
): HookFn =>
  schemeAuth<unknown>("basic", 'Basic realm="ignex"', (credentials, ctx) => {
    if (!isStrictBase64(credentials)) return null;
    let decoded: string;
    try {
      decoded = Buffer.from(credentials, "base64").toString("utf8");
    } catch {
      return null;
    }
    const colon = decoded.indexOf(":");
    const username = colon < 0 ? decoded : decoded.slice(0, colon);
    const password = colon < 0 ? "" : decoded.slice(colon + 1);
    return verify(username, password, ctx);
  });

/** Parse + verify HTTP Bearer credentials (`Authorization: Bearer <token>`). */
export const bearerAuth = (
  verify: (token: string, ctx: IgnexContext) => MaybePromise<unknown | null>,
  challenge = "Bearer",
): HookFn => schemeAuth<unknown>("bearer", challenge, verify);

/** Options for {@link jwtAuth}: JWT service options plus challenge behavior. */
export interface JwtAuthOptions extends JwtServiceOptions {
  /** Send a `WWW-Authenticate: Bearer` challenge on failure. */
  challenge?: boolean;
}

/** Authenticate a request using an HS256 bearer token (JWT). */
export const jwtAuth = (options: JwtAuthOptions): HookFn => {
  const jwt = createJwt(options);
  const challenge = options.challenge ?? true;

  return bearerAuth(
    (token) => {
      const claims = jwt.verify(token);
      return claims == null ? null : (claims as Record<string, unknown>);
    },
    challenge ? "Bearer" : undefined,
  );
};
