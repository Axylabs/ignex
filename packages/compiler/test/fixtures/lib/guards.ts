/**
 * Fixture "app boilerplate" — the withGuards guard factory lives in the APP
 * (this fixture mirrors a real app's src/lib/guards.ts). Route files chain
 * it in the route's `before` array; the compiler statically resolves the
 * conventional `withGuards` name and emits its guards at build time.
 */
import type { HookFn } from "@ignex/core";
import { composeGuards, guardChain } from "@ignex/core";

export interface RouteGuards {
  roles?: string[];
  permissions?: string[];
  all?: boolean;
  authenticated?: boolean;
}

export const withGuards = (guards: RouteGuards = {}): HookFn =>
  composeGuards(...guardChain(guards));
