/**
 * @fileoverview OpenAPI 3.1 Specification Generator.
 * Auto-generates docs from route definitions.
 */

import type { DocumentDecoration, HttpMethod, RouteSchema } from "./types";

export interface OpenAPIInfo {
  title: string;
  version: string;
  description?: string;
}

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  schema?: RouteSchema;
  detail?: DocumentDecoration;
}

export const generateOpenAPI = (
  info: OpenAPIInfo,
  routes: RouteDefinition[],
): Record<string, unknown> => {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    if (route.method === "ALL" || route.method === "WS") continue;

    const openApiPath = route.path.replace(/:(\w+)/g, "{$1}").replace(/\*(\w+)/g, "{$1}");

    if (!paths[openApiPath]) paths[openApiPath] = {};

    const operation: Record<string, unknown> = {
      operationId: `${route.method.toLowerCase()}_${openApiPath.replace(/[{}/]/g, "_")}`,
      ...route.detail,
      responses: { "200": { description: "Successful response" } },
    };

    if (route.schema?.params) {
      const schema = route.schema.params as any;
      const required = new Set(schema.required ?? []);

      operation.parameters = Object.entries(schema.properties ?? {}).map(
        ([name, propSchema]: [string, any]) => ({
          name,
          in: "path",
          required: required.has(name),
          schema: {
            type: propSchema.type ?? "string",
            ...(propSchema.format ? { format: propSchema.format } : {}),
            ...(propSchema.enum ? { enum: propSchema.enum } : {}),
          },
        }),
      );
    }

    if (route.schema?.query) {
      const schema = route.schema.query as any;
      const required = new Set(schema.required ?? []);

      const queryParams = Object.entries(schema.properties ?? {}).map(
        ([name, propSchema]: [string, any]) => ({
          name,
          in: "query",
          required: required.has(name),
          schema: {
            type: propSchema.type ?? "string",
            ...(propSchema.format ? { format: propSchema.format } : {}),
            ...(propSchema.enum ? { enum: propSchema.enum } : {}),
            ...(propSchema.default !== undefined ? { default: propSchema.default } : {}),
          },
        }),
      );

      operation.parameters = [...((operation.parameters as any[]) ?? []), ...queryParams];
    }

    if (route.schema?.body) {
      operation.requestBody = {
        content: { "application/json": { schema: route.schema.body } },
      };
    }

    paths[openApiPath][route.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info,
    paths,
  };
};
