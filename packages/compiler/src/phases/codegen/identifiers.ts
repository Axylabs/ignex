/**
 * @fileoverview Codegen: generated-identifier naming conventions.
 *
 * Every name the emitter produces for a route/helper lives here so naming
 * stays consistent and is easy to change in one place.
 */

import type { RouteIR } from "../../types";
import { escapeRegExp, pathRegexSource, wildcardNames } from "../../utils/route-path";

// Re-exported for existing callers (see codegen/index.ts).
export { escapeRegExp, wildcardNames };

export const handlerImportName = (route: RouteIR): string => `handler_${route.codegen.handlerRef}`;

/** Import name for a WS route module's `wsHandler` export. */
export const wsHandlerImportName = (route: RouteIR): string =>
  `wsHandler_${route.codegen.handlerRef}`;

export const methodHandlerName = (route: RouteIR): string =>
  `${route.source.method}_${route.codegen.handlerRef}`;

export const constantBodyVar = (route: RouteIR): string => `BODY_${route.codegen.handlerRef}`;

export const constantInitVar = (route: RouteIR): string => `INIT_${route.codegen.handlerRef}`;

export const hookIdent = (name: string): string => `hook_${name.replace(/[^a-zA-Z0-9_$]/g, "_")}`;

/** Module-level const name for a route's Nth guard hook. */
export const guardIdent = (route: RouteIR, index: number): string =>
  `__guard_${route.codegen.handlerRef}_${index}`;

/** A single emitted guard hook: its module-level const name + call expr. */
export interface GuardHookEmission {
  readonly ident: string;
  readonly expr: string;
}

/**
 * The guard hooks for a route (mirrors `@ignex/core`'s `guardChain`):
 * `roles` → `hasRole(...)`, `permissions` → `can(...)`/`canAll(...)`, and a
 * bare `withGuards(handler)` → `requireAuthenticated`. Each becomes a
 * module-level const referenced from the route's pre-execution hook array.
 */
export const guardHookEmissions = (route: RouteIR): GuardHookEmission[] => {
  const guards = route.analysis.guards;
  if (!guards) return [];
  const out: GuardHookEmission[] = [];
  const push = (expr: string): void => {
    out.push({ ident: guardIdent(route, out.length), expr });
  };
  if (guards.roles?.length) {
    push(`hasRole(${guards.roles.map((r) => JSON.stringify(r)).join(", ")})`);
  }
  if (guards.permissions?.length) {
    const fn = guards.all ? "canAll" : "can";
    push(`${fn}(${guards.permissions.map((p) => JSON.stringify(p)).join(", ")})`);
  } else if (!guards.roles?.length && guards.authenticated !== false) {
    push("requireAuthenticated");
  }
  return out;
};

export const cacheVar = (route: RouteIR): string => `CACHE_${route.codegen.handlerRef}`;

/** Frozen per-route context options const (hoisted — was a per-request literal). */
export const ctxOptsVar = (route: RouteIR): string => `__ctxOpts_${route.codegen.handlerRef}`;

/** Per-route pre-baked native stack const (`createNativeRoute` result, or null). */
export const nativeRouteVar = (route: RouteIR): string =>
  `__nativeRoute_${route.codegen.handlerRef}`;

export const coreHandlerName = (route: RouteIR, hasCache: boolean): string =>
  hasCache ? `core_${route.codegen.handlerRef}` : methodHandlerName(route);

export const validatorImportName = (route: RouteIR, kind: string): string =>
  `validate_${route.codegen.handlerRef}_${kind}`;

export const serializerImportName = (route: RouteIR, status: string): string =>
  `serialize_${route.codegen.handlerRef}_${status}`;

export const routeReplyFn = (route: RouteIR): string => {
  if (route.analysis.responseType === "text") return "textReply";
  if (route.analysis.responseType === "html") return "htmlReply";
  if (route.analysis.responseType === "stream") return "streamReply";
  return "jsonReply";
};

/** Extract `*name` wildcard identifiers from a path. */
export const wildcardPrefix = (path: string): string => {
  const idx = path.indexOf("*");
  return idx === -1 ? "" : path.slice(0, idx);
};

// ── Route-table naming ───────────────────────────────────────────

export const BUN_ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** Regex source for an exact-path matcher with `:param`/`*wildcard` segments. */
export const allowRegExp = (path: string): string => pathRegexSource(path);

/** Handler name used in the route table, honoring deduplication. */
export const routeHandlerName = (route: RouteIR): string =>
  route.decisions.dedupGroup
    ? `${route.source.method}_${route.decisions.dedupGroup}`
    : methodHandlerName(route);
