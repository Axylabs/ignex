/**
 * @fileoverview Codegen: reply/serializer shaping for the generated handler.
 */

import type { RouteIR } from "../../../types";
import { hookIdent } from "../identifiers";

/** Serializers object literal (per-status) or `undefined`. */
export const buildSerializersVar = (route: RouteIR): string =>
  route.decisions.serializers?.byStatus
    ? `{ ${Object.entries(route.decisions.serializers.byStatus)
        .map(([s, n]) => `${JSON.stringify(s)}: ${n}`)
        .join(", ")} }`
    : route.decisions.serializers?.json
      ? `{ "200": ${route.decisions.serializers.json} }`
      : "undefined";

/** Per-route hook identifiers array literal. */
export const buildRouteHookVar = (route: RouteIR): string =>
  route.analysis.hooks.length > 0 ? `[${route.analysis.hooks.map(hookIdent).join(", ")}]` : `[]`;
