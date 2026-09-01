/**
 * RBAC plugin — role- and permission-based authorization.
 *
 * `createRbac()` is an `IgnexPlugin` that normalizes the authenticated user's
 * claims onto `ctx.state` (`roles`/`permissions`, via `getRoles`/`getPermissions`)
 * so guards and handlers share one source of truth. It runs AFTER the auth
 * module in onion order (register `authModule().plugin()` first).
 *
 * The per-route authorization boilerplate lives in the APP (a `withGuards`
 * template built on the generic primitives here). Routes chain arbitrary
 * before/after hooks via `config`; the compiler resolves the conventional
 * `withGuards` wrapper statically and emits its guards at build time.
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

/** Options for {@link createRbac}. */
export interface RbacOptions extends SubjectResolver {
  /** Informational claim-shaping mode (role/permission/both). */
  mode?: "role" | "permission" | "both";
}

/**
 * NOTE: the per-route guard composition (`withGuards` and friends) is the
 * APP's boilerplate, not a framework export. The framework provides the
 * general per-route `before`/`after` hook chain (route `config` / wrapped
 * handler `.config` — compiled into the route pipeline) plus the generic
 * authz primitives (`requireAuthenticated`, `can`, `canAll`, `hasRole`,
 * `composeGuards`, `guardChain`) that an app template composes. The compiler
 * statically resolves the conventional `withGuards` wrapper name and emits
 * its guards at build time (the RBAC optimization); custom wrapper names are
 * honored generically (never hoisted, runtime hook chain read).
 */

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
