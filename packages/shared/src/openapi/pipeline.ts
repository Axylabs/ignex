/**
 * @fileoverview OpenAPI 3.1 Specification Generator (shared) — the composed
 * pipeline.
 *
 * Lives in `@ignex/shared` — the compiler ↔ runtime contract vocabulary — so
 * `@ignex/core` (runtime docs) and `@ignex/compiler` (generated openapi.json)
 * share ONE implementation with zero cross-package import risk. `shared` has
 * no runtime dependencies, so this module is importable from anywhere.
 *
 * The generator is a pure, composed pipeline (`pipe` over named stages) so
 * each concern — path conversion, parameter shaping, response mapping,
 * component hoisting — is a small, independently testable function:
 *
 *   openapi/schema.ts      — guards + path/operation vocabulary
 *   openapi/params.ts      — parameter shaping
 *   openapi/operation.ts   — request body / responses / operation object
 *   openapi/components.ts  — $defs hoisting + derived tags
 *   openapi/types.ts       — the public contract types
 */

import { pipe } from "../fp";
import { collectDocumentTags, type DocState, hoistComponents } from "./components";
import { operationFor } from "./operation";
import type { OpenAPIDocument, OpenAPIInfo, RouteDefinition } from "./types";

/**
 * Routes that can't become documentable operations — `ALL`/`WS` methods and
 * routes explicitly marked `detail.hide: true` (e.g. the `openapi()` plugin's
 * own spec/docs routes) — are dropped up front.
 */
const skipUnroutable = (routes: readonly RouteDefinition[]): readonly RouteDefinition[] =>
  routes.filter(
    (route) => route.method !== "ALL" && route.method !== "WS" && route.detail?.hide !== true,
  );

const groupByPath = (
  routes: readonly RouteDefinition[],
): Record<string, Record<string, Record<string, unknown>>> => {
  const paths: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const route of routes) {
    const { method, openApiPath, operation } = operationFor(route);
    paths[openApiPath] ??= {};
    paths[openApiPath][method] = operation;
  }
  return paths;
};

const buildDocument =
  (info: OpenAPIInfo) =>
  ({ paths, components }: DocState): OpenAPIDocument => {
    const document: OpenAPIDocument = {
      openapi: "3.1.0",
      info,
      paths,
    };
    if (Object.keys(components.schemas).length > 0) {
      document.components = components;
    }
    const tags = collectDocumentTags(paths);
    if (tags.length > 0) {
      document.tags = tags;
    }
    return document;
  };

/**
 * Generate a full OpenAPI 3.1 document from route definitions.
 *
 * Pure pipeline (skip unroutable → group by path → hoist components → build
 * document). `ALL`/`WS` routes are dropped; `$defs` are hoisted into
 * `components.schemas` and `#/$defs/…` refs rewritten to the components form.
 *
 * @param info - Document metadata (`title`/`version`/`description`).
 * @param routes - The route definitions to describe.
 * @returns The OpenAPI 3.1 document.
 */
export const generateOpenAPI = (
  info: OpenAPIInfo,
  routes: readonly RouteDefinition[],
): OpenAPIDocument =>
  pipe(routes)(skipUnroutable, groupByPath, hoistComponents, buildDocument(info));
