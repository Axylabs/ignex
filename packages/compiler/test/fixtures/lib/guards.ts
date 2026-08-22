/**
 * Fixture "app boilerplate" — the withGuards template lives in the APP (this
 * fixture mirrors a real app's src/lib/guards.ts). Route files import it; the
 * compiler still statically resolves the conventional `withGuards` wrapper
 * name and emits its guards at build time.
 */
import type { HookFn } from "@ignex/core";
import { can, canAll, hasRole, requireAuthenticated } from "@ignex/core";

export interface RouteGuards {
  roles?: string[];
  permissions?: string[];
  all?: boolean;
  authenticated?: boolean;
}

export const withGuards = <H extends (...args: never[]) => unknown>(
  handler: H,
  guards: RouteGuards = {},
): H => {
  const before: HookFn[] = [];
  if (guards.authenticated !== false) before.push(requireAuthenticated);
  if (guards.roles?.length) before.push(hasRole(...guards.roles));
  if (guards.permissions?.length) {
    before.push(guards.all ? canAll(...guards.permissions) : can(...guards.permissions));
  }
  (handler as unknown as { config?: { before: HookFn[] } }).config = { before };
  return handler;
};
