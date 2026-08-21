/**
 * RBAC plugin — role- and permission-based authorization.
 *
 * `createRbac()` is an `IgnexPlugin` that normalizes the authenticated user's
 * claims onto `ctx.state` (`roles`/`permissions`, via `getRoles`/`getPermissions`)
 * so guards and handlers share one source of truth. It runs AFTER the auth
 * module in onion order (register `authModule().plugin()` first).
 *
 * `withGuards(handler, guards)` is the per-route ergonomic: a higher-order
 * handler that runs the guard chain (pre-execution) before the inner handler,
 * so it works in BOTH the interpreted runtime and the AOT compiler:
 *
 * ```ts
 * import { withGuards } from "@ignex/core";
 * import { post } from "@ignex/core/http";
 *
 * export default withGuards(post(createProduct, schema), {
 *   roles: ["admin"],
 *   permissions: ["products:write"],   // any-of within each group
 * });
 * ```
 *
 * Guards map onto the existing `HookFn` engine (401 unauthenticated / 403
 * forbidden) and compose with `config.hooks` / the hook lifecycle.
 */
import type { IgnexContext } from "../http/context";
import type { IgnexPlugin } from "../lifecycle/plugin";
import { type AuthUser, getUser } from "../security/auth";
import {
  can,
  canAll,
  composeGuards,
  guardChain,
  hasRole,
  PERMISSIONS_KEY,
  ROLES_KEY,
  type RouteGuards,
  requireAuthenticated,
  type SubjectResolver,
} from "../security/rbac";
import type { MaybePromise } from "../types";

export type { AuthMode } from "../security/auth-module";

/** Options for {@link createRbac}. */
export interface RbacOptions extends SubjectResolver {
  /** Informational claim-shaping mode (role/permission/both). */
  mode?: "role" | "permission" | "both";
}

/**
 * Wrap a route handler so the guard chain runs before it. Returns a handler
 * compatible with the route DSL (`get`/`post`/…) and the AOT compiler; the
 * inner handler's inferred schema/return types are preserved.
 *
 * - no user            → 401 (unauthenticated)
 * - user lacks a guard → 403 (forbidden)
 * - `{}` (no guards)   → require an authenticated user only
 */
export const withGuards = <H extends (ctx: IgnexContext) => MaybePromise<unknown>>(
  handler: H,
  guards: RouteGuards = {},
): H => {
  const runGuards = composeGuards(...guardChain(guards));
  const wrapped = async (ctx: IgnexContext): Promise<unknown> => {
    const result = await runGuards(ctx);
    if (!result.ok) return result.response;
    return (handler as (c: IgnexContext) => MaybePromise<unknown>)(ctx);
  };
  return wrapped as H;
};

/**
 * Create the RBAC plugin. `onRequest` normalizes the authenticated user's
 * claims onto `ctx.state` (`roles`/`permissions`); with a custom `loadUser` it
 * can resolve the subject itself (no auth module required).
 */
export const createRbac = (options: RbacOptions = {}): IgnexPlugin => {
  const { loadUser } = options;
  return {
    name: "rbac",
    version: "1.0.0",
    onRequest(ctx) {
      if (loadUser) {
        // Custom subject resolver — must await (may be async/DB-backed).
        return (async () => {
          const user = (await loadUser(ctx)) ?? null;
          normalize(ctx, user);
          return ctx;
        })();
      }
      normalize(ctx, getUser(ctx) ?? null);
      return ctx;
    },
  };
};

/** Copy a user's role/permission claims onto `ctx.state`. */
const normalize = (ctx: IgnexContext, user: AuthUser | null): void => {
  if (user == null) return;
  if (user.roles !== undefined) ctx.setState(ROLES_KEY, (user.roles as string[]) ?? []);
  if (user.permissions !== undefined) {
    ctx.setState(PERMISSIONS_KEY, (user.permissions as string[]) ?? []);
  }
};

/** Compose an authorization hook from role + permission requirements. */
export const authorize = (guards: RouteGuards): ReturnType<typeof composeGuards> =>
  composeGuards(...guardChain(guards));

export type { RouteGuards, SubjectResolver } from "../security/rbac";
export { getPermissions, getRoles, permissionMatches } from "../security/rbac";
export { can, canAll, composeGuards, guardChain, hasRole, requireAuthenticated };
