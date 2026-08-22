/**
 * RBAC guards — role-based and permission-based authorization hooks.
 *
 * Guards are `HookFn`s that run in the pre-execution chain (before the route
 * handler) and read the authenticated user from `ctx.state` (set by the auth
 * module's `onRequest`). Semantics:
 *   - no user             → 401 `Unauthorized` (with `WWW-Authenticate`)
 *   - user lacks role/perm → 403 `Forbidden`
 *   - authorized          → continue the chain
 *
 * Permission matching supports exact strings (`users:read`), the global
 * wildcard (`*`), and namespace wildcards (`users:*`).
 */
import type { IgnexContext } from "../http/context";
import { composeHooks, continueHook, type HookFn, haltHook } from "../lifecycle/hooks";
import type { MaybePromise } from "../types";
import { type AuthUser, forbidden, getUser, unauthorized } from "./auth";

/** `ctx.state` key holding the normalized role list (set by the rbac plugin). */
export const ROLES_KEY = Symbol.for("ignex.rbac.roles");
/** `ctx.state` key holding the normalized permission list (set by the rbac plugin). */
export const PERMISSIONS_KEY = Symbol.for("ignex.rbac.permissions");

/** Read the normalized role list from `ctx.state`. */
export const getRoles = (ctx: IgnexContext): string[] | undefined =>
  ctx.getState<string[]>(ROLES_KEY);

/** Read the normalized permission list from `ctx.state`. */
export const getPermissions = (ctx: IgnexContext): string[] | undefined =>
  ctx.getState<string[]>(PERMISSIONS_KEY);

/** A subject resolver: where the guard reads roles/permissions from. */
export interface SubjectResolver {
  /** Read the authenticated subject (default: `ctx.state.user` via `getUser`). */
  loadUser?: (ctx: IgnexContext) => MaybePromise<AuthUser | null>;
}

/** Resolve the authenticated user (claims) for a context. */
export const resolveUser = async (
  ctx: IgnexContext,
  opts: SubjectResolver = {},
): Promise<AuthUser | null> => (opts.loadUser ? opts.loadUser(ctx) : (getUser(ctx) ?? null));

/**
 * Build a guard from a predicate over the authenticated subject. Shared
 * skeleton behind `requireAuthenticated` / `hasRole` / `can` / `canAll`:
 * 401 when unauthenticated, 403 when the predicate fails, else continue.
 */
const guard =
  (authorize: (user: AuthUser, ctx: IgnexContext) => boolean): HookFn =>
  async (ctx) => {
    const user = await resolveUser(ctx);
    if (user == null) return haltHook(unauthorized());
    return authorize(user, ctx) ? continueHook(ctx) : haltHook(forbidden());
  };

/**
 * Require an authenticated user (no role/permission check). 401 when absent.
 * The guard used when a route requires authentication with no role/permission checks.
 */
export const requireAuthenticated: HookFn = guard(() => true);

/**
 * True when a `grant` (a permission the subject holds) satisfies a `requirement`
 * (a route's `can(...)` pattern). Exact (`users:read`), global wildcard (`*`),
 * and namespace wildcards on EITHER side (`users:*` requirement matches a
 * `users:read` grant, and a `users:*` grant satisfies a `users:read`
 * requirement). Requirement is first, grant second.
 */
export const permissionMatches = (requirement: string, grant: string): boolean => {
  if (requirement === "*" || grant === "*") return true;
  if (requirement.endsWith(":*")) {
    // Requirement is a namespace umbrella: grant must sit in that namespace.
    const ns = requirement.slice(0, -1);
    return grant.startsWith(ns) || grant === requirement;
  }
  if (grant.endsWith(":*")) {
    // Grant is a namespace umbrella: covers the exact requirement.
    return requirement.startsWith(grant.slice(0, -1));
  }
  return requirement === grant;
};

/** True when `granted` covers EVERY required pattern. */
export const hasAllPermissions = (granted: string[], required: string[]): boolean =>
  required.every((r) => granted.some((g) => permissionMatches(r, g)));

/** True when `granted` covers AT LEAST ONE required pattern. */
export const hasAnyPermission = (granted: string[], required: string[]): boolean =>
  required.some((r) => granted.some((g) => permissionMatches(r, g)));

/** The role/permission lists granted to a user (claims or normalized state). */
const subjectGrants = (
  ctx: IgnexContext,
  user: AuthUser | null,
): { roles: string[]; permissions: string[] } => ({
  roles: (user?.roles as string[] | undefined) ?? getRoles(ctx) ?? [],
  permissions: (user?.permissions as string[] | undefined) ?? getPermissions(ctx) ?? [],
});

/**
 * Require the authenticated user to hold ANY of the given roles.
 *
 * ```ts
 * // app template (boilerplate): withGuards(handler, { roles: ["admin"] })
 * // or as a hook: config.hooks = ["require-auth"] then can(...) in a wrapper
 * ```
 */
export const hasRole = (...roles: string[]): HookFn =>
  roles.length === 0
    ? continueHook
    : guard((user, ctx) => subjectGrants(ctx, user).roles.some((r) => roles.includes(r)));

/**
 * Require the authenticated user to hold ANY of the given permissions.
 *
 * ```ts
 * can("users:read", "users:write")  // any-of
 * ```
 */
export const can = (...permissions: string[]): HookFn =>
  permissions.length === 0
    ? continueHook
    : guard((user, ctx) => hasAnyPermission(subjectGrants(ctx, user).permissions, permissions));

/** Require the authenticated user to hold ALL of the given permissions. */
export const canAll = (...permissions: string[]): HookFn =>
  permissions.length === 0
    ? continueHook
    : guard((user, ctx) => hasAllPermissions(subjectGrants(ctx, user).permissions, permissions));

/** Guard requirements for a route (used by `guardChain` / the app's guard template). */
export interface RouteGuards {
  /** Require ANY of these roles. */
  roles?: string[];
  /** Require ANY of these permissions (or ALL when `all: true`). */
  permissions?: string[];
  /** When true, require ALL listed permissions instead of any. */
  all?: boolean;
  /** Require an authenticated user only (no role/permission check). */
  authenticated?: boolean;
}

/**
 * Build the guard chain for a set of route requirements. An empty `guards`
 * (or `authenticated: true`) yields a bare authentication requirement.
 */
export const guardChain = (guards: RouteGuards = {}): HookFn[] => {
  const chain: HookFn[] = [];
  if (guards.roles?.length) chain.push(hasRole(...guards.roles));
  if (guards.permissions?.length) {
    chain.push(guards.all ? canAll(...guards.permissions) : can(...guards.permissions));
  } else if (guards.authenticated !== false && chain.length === 0) {
    // Default: at minimum an authenticated user is required.
    chain.push(requireAuthenticated);
  }
  return chain;
};

/**
 * Compose multiple guard hooks into a single hook (run left-to-right).
 *
 * Delegates to the shared hook engine's `composeHooks` — guard hooks ARE
 * `HookFn`s, so there is no reason to re-implement chain running here.
 */
export const composeGuards = (...guards: HookFn[]): HookFn =>
  composeHooks(...guards.filter(Boolean));
