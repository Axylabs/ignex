/**
 * @fileoverview Auth plugin convenience wrappers.
 *
 * Wraps the auth hooks from `../auth` as `FluxPlugin`s so they compose with
 * the existing plugin system (`composePlugins`, app.config `plugins`).
 */

import {
  type AuthUser,
  basicAuth,
  bearerAuth,
  type JwtAuthOptions,
  jwtAuth,
  optionalAuth,
  requireAuth,
} from "../auth";
import type { FluxContext } from "../context";
import type { HookFn } from "../hooks";
import type { FluxPlugin } from "../plugin";
import type { MaybePromise } from "../types";

/** Turn any request hook into a `FluxPlugin`. */
export const auth = (hook: HookFn): FluxPlugin => ({
  name: "auth",
  async onRequest(ctx) {
    const result = await hook(ctx);
    return result.ok ? result.ctx : result.response;
  },
});

/** Require a user (from a custom extractor) on every request. */
export const authGuard = <T>(extract: (ctx: FluxContext) => MaybePromise<T | null>): FluxPlugin =>
  auth(requireAuth(extract));

/** Attach a user when present, but never reject. */
export const optionalAuthPlugin = <T>(
  extract: (ctx: FluxContext) => MaybePromise<T | null>,
): FluxPlugin => auth(optionalAuth(extract));

/** JWT bearer auth plugin. */
export const jwtAuthPlugin = (options: JwtAuthOptions): FluxPlugin => auth(jwtAuth(options));

/** Basic credentials auth plugin. */
export const basicAuthPlugin = (
  verify: (username: string, password: string, ctx: FluxContext) => MaybePromise<AuthUser | null>,
): FluxPlugin => auth(basicAuth(verify));

/** Custom bearer-token auth plugin. */
export const bearerAuthPlugin = (
  verify: (token: string, ctx: FluxContext) => MaybePromise<AuthUser | null>,
): FluxPlugin => auth(bearerAuth(verify));
