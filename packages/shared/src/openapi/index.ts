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
// Shared with the compiler: `ignex sdk` reads the same manifest paths, and a
// private copy there drifted from this rule once already.
export { toOpenApiPath } from "./schema";
export type {
  OpenAPIDocument,
  OpenAPIInfo,
  OpenAPIRouteSchema,
  ParameterDoc,
  ParameterLocation,
  RouteDefinition,
} from "./types";
