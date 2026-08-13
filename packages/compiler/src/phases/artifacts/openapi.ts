/**
 * @fileoverview `openapi.json` artifact — delegates to the shared OpenAPI
 * generator (single source of truth).
 */

import { generateOpenAPI } from "@ignex/shared";
import type { CompilerOptions, RouteIR } from "../../types";

const toRouteDefinition = (route: RouteIR): Parameters<typeof generateOpenAPI>[1][number] => {
  const schemaDoc = route.decisions.schemaDoc as Record<string, unknown> | undefined;
  const detail = route.analysis.config?.detail;
  const definition: Parameters<typeof generateOpenAPI>[1][number] = {
    method: route.source.method,
    path: route.source.path,
    paramNames: route.source.paramNames,
    usesBody: route.analysis.usage.body === true,
  };
  if (schemaDoc) {
    definition.schema = {
      params: schemaDoc.params,
      query: schemaDoc.query,
      headers: schemaDoc.headers,
      body: schemaDoc.body,
      cookie: schemaDoc.cookie,
      response: schemaDoc.response,
    };
  }
  if (detail && typeof detail === "object") {
    definition.detail = detail as Record<string, unknown>;
  }
  return definition;
};

/**
 * OpenAPI 3.1 shaping for the built app. This delegates to the shared
 * `generateOpenAPI` (from `@ignex/shared`) — the single source of truth — so
 * the runtime docs and the compiled `openapi.json` can never drift. Only the
 * RouteIR → `RouteDefinition` mapping lives here.
 */
export const generateOpenApi = (
  routes: readonly RouteIR[],
  opts: CompilerOptions,
): Record<string, unknown> =>
  generateOpenAPI(
    {
      title: opts.serviceName ?? "ignex",
      version: "1.0.0",
    },
    routes.map(toRouteDefinition),
  ) as Record<string, unknown>;
