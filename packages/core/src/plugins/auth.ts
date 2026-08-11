/**
 * @fileoverview Auth plugin convenience wrappers.
 *
 * Wraps the auth hooks from `../auth` as `IgnusPlugin`s so they compose with
 * the existing plugin system (`composePlugins`, app.config `plugins`).
 */

import type { IgnusContext } from "../http/context";
import type { HookFn } from "../lifecycle/hooks";
import { hookToPlugin, type IgnusPlugin } from "../lifecycle/plugin";
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

/** Turn any request hook into a `IgnusPlugin`. */
export const auth = (hook: HookFn): IgnusPlugin => hookToPlugin("auth", hook);

/** Require a user (from a custom extractor) on every request. */
export const authGuard = <T>(extract: (ctx: IgnusContext) => MaybePromise<T | null>): IgnusPlugin =>
  auth(requireAuth(extract));

/** Attach a user when present, but never reject. */
export const optionalAuthPlugin = <T>(
  extract: (ctx: IgnusContext) => MaybePromise<T | null>,
): IgnusPlugin => auth(optionalAuth(extract));

/** JWT bearer auth plugin. */
export const jwtAuthPlugin = (options: JwtAuthOptions): IgnusPlugin => auth(jwtAuth(options));

/** Basic credentials auth plugin. */
export const basicAuthPlugin = (
  verify: (username: string, password: string, ctx: IgnusContext) => MaybePromise<AuthUser | null>,
): IgnusPlugin => auth(basicAuth(verify));

/** Custom bearer-token auth plugin. */
export const bearerAuthPlugin = (
  verify: (token: string, ctx: IgnusContext) => MaybePromise<AuthUser | null>,
): IgnusPlugin => auth(bearerAuth(verify));
