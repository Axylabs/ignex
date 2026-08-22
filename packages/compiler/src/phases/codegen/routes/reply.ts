/**
 * @fileoverview Codegen: reply/serializer shaping for the generated handler.
 */

import type { RouteIR } from "../../../types";
import { guardHookEmissions, hookIdent } from "../identifiers";

/** Serializers object literal (per-status) or `undefined`. */
export const buildSerializersVar = (route: RouteIR): string =>
  route.decisions.serializers?.byStatus
    ? `{ ${Object.entries(route.decisions.serializers.byStatus)
        .map(([s, n]) => `${JSON.stringify(s)}: ${n}`)
        .join(", ")} }`
    : route.decisions.serializers?.json
      ? `{ "200": ${route.decisions.serializers.json} }`
      : "undefined";

/** Generated import name for a route module's `config` export (when present). */
export const configImportName = (route: RouteIR): string => `cfg_${route.codegen.handlerRef}`;

/**
 * The route-local BEFORE chain array literal. Order:
 *   1. runtime `config.before`  (module `config` export — statically emitted
 *      when evaluable, else read from the imported module at runtime)
 *   2. runtime `handler.config.before` (wrapper-attached guards — the app's
 *      boilerplate `withGuards` template)
 *   3. named `config.hooks`  (the existing hooksDir mechanism)
 *   4. statically-extracted RBAC guards (the compiler optimization)
 *
 * Static entries win when present; the runtime spreads are only emitted for
 * modules that actually export `config` or wrap the handler (flag-gated), so
 * plain routes pay zero spread cost.
 */
export const buildRouteBeforeVar = (route: RouteIR): string => {
  const ids: string[] = [];
  if (route.analysis.configExport) {
    ids.push(`...(${configImportName(route)}?.before ?? [])`);
  }
  if (route.analysis.wrappedHandler) {
    ids.push(`...(handler_${route.codegen.handlerRef}?.config?.before ?? [])`);
  }
  for (const hookName of route.analysis.hooks) ids.push(hookIdent(hookName));
  for (const g of guardHookEmissions(route)) ids.push(g.ident);
  return ids.length > 0 ? `[${ids.join(", ")}]` : `[]`;
};

/** The route-local AFTER chain array literal (module config + handler config). */
export const buildRouteAfterVar = (route: RouteIR): string => {
  const ids: string[] = [];
  if (route.analysis.configExport) {
    ids.push(`...(${configImportName(route)}?.after ?? [])`);
  }
  if (route.analysis.wrappedHandler) {
    ids.push(`...(handler_${route.codegen.handlerRef}?.config?.after ?? [])`);
  }
  return ids.length > 0 ? `[${ids.join(", ")}]` : `[]`;
};

/** True when the route carries route-local hooks of any kind. */
export const routeHasLocalHooks = (route: RouteIR): boolean =>
  route.analysis.configExport ||
  route.analysis.wrappedHandler ||
  route.analysis.hooks.length > 0 ||
  guardHookEmissions(route).length > 0;
