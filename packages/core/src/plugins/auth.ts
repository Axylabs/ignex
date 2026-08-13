/**
 * @fileoverview Auth plugin convenience wrappers.
 *
 * Wraps the auth hooks from `../auth` as `IgnexPlugin`s so they compose with
 * the existing plugin system (`composePlugins`, app.config `plugins`).
 */

import type { IgnexContext } from "../http/context";
import type { HookFn } from "../lifecycle/hooks";
import { hookToPlugin, type IgnexPlugin } from "../lifecycle/plugin";
import {
  type AuthUser,
  basicAuth,
  bearerAuth,
  type JwtAuthOptions,
  jwtAuth,
  optionalAuth,
  requireAuth,
} from "../security/auth";
import type { MaybePromise } from "../types";

/** Turn any request hook into a `IgnexPlugin`. */
export const auth = (hook: HookFn): IgnexPlugin => hookToPlugin("auth", hook);

/** Require a user (from a custom extractor) on every request. */
export const authGuard = <T>(extract: (ctx: IgnexContext) => MaybePromise<T | null>): IgnexPlugin =>
  auth(requireAuth(extract));

/** Attach a user when present, but never reject. */
export const optionalAuthPlugin = <T>(
  extract: (ctx: IgnexContext) => MaybePromise<T | null>,
): IgnexPlugin => auth(optionalAuth(extract));

/** JWT bearer auth plugin. */
export const jwtAuthPlugin = (options: JwtAuthOptions): IgnexPlugin => auth(jwtAuth(options));

/** Basic credentials auth plugin. */
export const basicAuthPlugin = (
  verify: (username: string, password: string, ctx: IgnexContext) => MaybePromise<AuthUser | null>,
): IgnexPlugin => auth(basicAuth(verify));

/** Custom bearer-token auth plugin. */
export const bearerAuthPlugin = (
  verify: (token: string, ctx: IgnexContext) => MaybePromise<AuthUser | null>,
): IgnexPlugin => auth(bearerAuth(verify));
