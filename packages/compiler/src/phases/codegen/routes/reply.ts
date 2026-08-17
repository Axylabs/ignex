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

/** Per-route hook identifiers array literal (named hooks + RBAC guards). */
export const buildRouteHookVar = (route: RouteIR): string => {
  const ids = route.analysis.hooks.map(hookIdent);
  for (const g of guardHookEmissions(route)) ids.push(g.ident);
  return ids.length > 0 ? `[${ids.join(", ")}]` : `[]`;
};
