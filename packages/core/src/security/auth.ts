/**
 * Authentication middleware — higher-order hooks.
 *
 * Composable with the hook engine (`composeHooks`, `continueHook`, `haltHook`).
 * Each factory returns a `HookFn` that resolves a user onto `ctx.state` (via
 * {@link getUser}/{@link setUser}) or halts with a 401.
 */
import type { FluxContext } from "../http/context";
import { continueHook, type HookFn, haltHook } from "../lifecycle/hooks";
import type { MaybePromise } from "../types";
import { createJwt, type JwtServiceOptions } from "./crypto";

/** Key under which the resolved user is stored on `ctx.state`. */
export const USER_KEY = Symbol.for("flux.user");

export type AuthUser = Record<string, unknown>;

/** Read the authenticated user from a context. */
export const getUser = <T = AuthUser>(ctx: FluxContext): T | undefined => ctx.getState<T>(USER_KEY);

/** Attach the authenticated user to a context. */
export const setUser = (ctx: FluxContext, user: unknown): void => ctx.setState(USER_KEY, user);

export const unauthorized = (challenge?: string): Response => {
  const headers: Record<string, string> = {};
  if (challenge) headers["www-authenticate"] = challenge;
  return Response.json({ error: "Unauthorized" }, { status: 401, headers });
};

/**
 * Halt unless a user can be extracted. On success the user is attached to
 * `ctx.state`; on failure the request is halted with a 401.
 */
export const requireAuth =
  <T>(extract: (ctx: FluxContext) => MaybePromise<T | null>): HookFn =>
  async (ctx) => {
    const user = await extract(ctx);
    if (user == null) return haltHook(unauthorized());
    setUser(ctx, user);
    return continueHook(ctx);
  };

/**
 * Attach a user when one can be extracted, but never halt — for endpoints
 * that work for guests and authenticated users alike.
 */
export const optionalAuth =
  <T>(extract: (ctx: FluxContext) => MaybePromise<T | null>): HookFn =>
  async (ctx) => {
    const user = await extract(ctx);
    if (user != null) setUser(ctx, user);
    return continueHook(ctx);
  };

/** Split an `Authorization` header into its (lowercased) scheme + credentials. */
const parseAuthorizationHeader = (ctx: FluxContext): { scheme: string; credentials: string } => {
  const header = ctx.headers.get("authorization") ?? "";
  const space = header.indexOf(" ");
  const scheme = space < 0 ? header : header.slice(0, space);
  const credentials = space < 0 ? "" : header.slice(space + 1);

  return { scheme: scheme.toLowerCase(), credentials };
};

/** Parse + verify HTTP Basic credentials (`Authorization: Basic base64(u:p)`). */
export const basicAuth =
  (
    verify: (username: string, password: string, ctx: FluxContext) => MaybePromise<unknown | null>,
  ): HookFn =>
  async (ctx) => {
    const { scheme, credentials } = parseAuthorizationHeader(ctx);

    if (scheme !== "basic" || !credentials) {
      return haltHook(unauthorized('Basic realm="flux"'));
    }

    let decoded: string;
    try {
      decoded = Buffer.from(credentials, "base64").toString("utf8");
    } catch {
      return haltHook(unauthorized('Basic realm="flux"'));
    }

    const colon = decoded.indexOf(":");
    const username = colon < 0 ? decoded : decoded.slice(0, colon);
    const password = colon < 0 ? "" : decoded.slice(colon + 1);

    const user = await verify(username, password, ctx);
    if (user == null) return haltHook(unauthorized('Basic realm="flux"'));
    setUser(ctx, user);
    return continueHook(ctx);
  };

/** Parse + verify HTTP Bearer credentials (`Authorization: Bearer <token>`). */
export const bearerAuth =
  (
    verify: (token: string, ctx: FluxContext) => MaybePromise<unknown | null>,
    challenge = "Bearer",
  ): HookFn =>
  async (ctx) => {
    const { scheme, credentials: token } = parseAuthorizationHeader(ctx);

    if (scheme !== "bearer" || !token) {
      return haltHook(unauthorized(challenge));
    }

    const user = await verify(token, ctx);
    if (user == null) return haltHook(unauthorized(challenge));
    setUser(ctx, user);
    return continueHook(ctx);
  };

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
