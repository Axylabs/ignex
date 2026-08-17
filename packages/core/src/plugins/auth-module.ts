/**
 * Auth module plugin factory — composes cleanly with the existing plugin
 * system (`composePlugins`, app.config `plugins`).
 *
 * ```ts
 * // app.config.ts
 * import { authModule, rbac } from "@ignex/core";
 * export const plugins = [
 *   authModule({ mode: "both", ttlSeconds: 3600 }),
 *   rbac(),
 * ];
 * ```
 */
import type { IgnexPlugin } from "../lifecycle/plugin";
import {
  type AuthMode,
  type AuthModule,
  type AuthModuleOptions,
  createAuthModule,
} from "../security/auth-module";

export type { AuthMode, AuthModule, AuthModuleOptions };

/**
 * Create the auth module as an `IgnexPlugin`: boots Ed25519 keys into `.env`
 * on `init()`, attaches the authenticated user (from a bearer EdDSA JWT) on
 * every request. Guards (`can`/`hasRole`/`withGuards`) run after it.
 */
export const authModule = (options: AuthModuleOptions): IgnexPlugin =>
  createAuthModule(options).plugin();

/** The full auth module handle (plugin + `issueToken`/`middleware`/`jwt`). */
export { createAuthModule } from "../security/auth-module";
