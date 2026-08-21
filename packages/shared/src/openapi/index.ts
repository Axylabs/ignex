/**
 * @fileoverview `openapi` — the shared OpenAPI 3.1 generator.
 *
 * Pure composed pipeline split by concern: schema shaping (`schema.ts`),
 * parameters (`params.ts`), operations (`operation.ts`), components
 * (`components.ts`) and the composition (`pipeline.ts`). The public surface
 * (`generateOpenAPI` + the contract types) is re-exported here so
 * `@ignex/shared`'s `export * from "./openapi"` stays unchanged.
 */

export { generateOpenAPI } from "./pipeline";
export type {
  OpenAPIDocument,
  OpenAPIInfo,
  OpenAPIRouteSchema,
  ParameterDoc,
  ParameterLocation,
  RouteDefinition,
} from "./types";
