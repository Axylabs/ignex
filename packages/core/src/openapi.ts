/**
 * @fileoverview OpenAPI 3.1 Specification Generator — public facade.
 *
 * The implementation lives in `@ignex/shared` (the compiler ↔ runtime
 * contract vocabulary), so `@ignex/core` (runtime docs) and `@ignex/compiler`
 * (generated openapi.json) share one generator with zero cross-package import
 * risk. This module re-exports it to keep the public `@ignex/core/openapi`
 * subpath and the `generateOpenAPI` export stable.
 */

export {
  generateOpenAPI,
  type OpenAPIDocument,
  type OpenAPIInfo,
  type OpenAPIRouteSchema,
  type ParameterDoc,
  type RouteDefinition,
} from "@ignex/shared";
