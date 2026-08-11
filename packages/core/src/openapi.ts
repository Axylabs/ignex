/**
 * @fileoverview OpenAPI 3.1 Specification Generator — public facade.
 *
 * The implementation lives in `@ignus/shared` (the compiler ↔ runtime
 * contract vocabulary), so `@ignus/core` (runtime docs) and `@ignus/compiler`
 * (generated openapi.json) share one generator with zero cross-package import
 * risk. This module re-exports it to keep the public `@ignus/core/openapi`
 * subpath and the `generateOpenAPI` export stable.
 */

export {
  generateOpenAPI,
  type OpenAPIDocument,
  type OpenAPIInfo,
  type OpenAPIRouteSchema,
  type ParameterDoc,
  type RouteDefinition,
} from "@ignus/shared";
