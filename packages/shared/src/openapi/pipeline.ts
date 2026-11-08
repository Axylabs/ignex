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
import { toOpenApiPath } from "./schema";
import type {
  OpenAPIDocument,
  OpenAPIDocumentOptions,
  OpenAPIInfo,
  RouteDefinition,
} from "./types";

const isStaticFile = (path: string): boolean => {
  const segment = path.slice(path.lastIndexOf("/") + 1);
  return segment.includes(".") && !segment.endsWith(".");
};

const matchesPath = (route: RouteDefinition, pattern: string | RegExp): boolean => {
  if (typeof pattern === "string") {
    return route.path === pattern || toOpenApiPath(route.path) === pattern;
  }
  pattern.lastIndex = 0;
  return pattern.test(route.path) || pattern.test(toOpenApiPath(route.path));
};

/** Drop unroutable, hidden, and explicitly excluded operations up front. */
const skipUnroutable = (
  routes: readonly RouteDefinition[],
  options: OpenAPIDocumentOptions,
): readonly RouteDefinition[] => {
  const methods = new Set(options.exclude?.methods?.map((method) => method.toLowerCase()));
  return routes.filter(
    (route) =>
      route.method !== "ALL" &&
      route.method !== "WS" &&
      route.detail?.hide !== true &&
      !methods.has(route.method.toLowerCase()) &&
      !(options.exclude?.staticFile === true && isStaticFile(route.path)) &&
      !options.exclude?.paths?.some((pattern) => matchesPath(route, pattern)),
  );
};

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
  (info: OpenAPIInfo, options: OpenAPIDocumentOptions) =>
  ({ paths, components }: DocState): OpenAPIDocument => {
    const document: OpenAPIDocument = {
      openapi: "3.1.0",
      info,
      paths,
    };
    if (Object.keys(components.schemas).length > 0) {
      document.components = components;
    }
    if (options.servers !== undefined) document.servers = [...options.servers];
    if (options.security !== undefined) document.security = [...options.security];
    const tags = options.tags === undefined ? collectDocumentTags(paths) : [...options.tags];
    if (options.tags !== undefined || tags.length > 0) {
      document.tags = tags;
    }
    return document;
  };

const transformDocument = (
  document: OpenAPIDocument,
  options: OpenAPIDocumentOptions,
): OpenAPIDocument => {
  const transformed = options.transform === undefined ? document : options.transform(document);
  if (transformed === null || typeof transformed !== "object" || Array.isArray(transformed)) {
    throw new Error("OpenAPI transform must return a document object");
  }
  return transformed;
};

/**
 * Generate a full OpenAPI 3.1 document from route definitions.
 *
 * Pure pipeline (skip unroutable → group by path → hoist components → build
 * document → optional transform). `ALL`/`WS` routes are dropped; `$defs` are
 * hoisted into `components.schemas` and refs rewritten to the components form.
 *
 * @param info - Document metadata (`title`/`version`/`description`).
 * @param routes - The route definitions to describe.
 * @param options - Shared exclusions, document fields, and final transform.
 * @returns The OpenAPI 3.1 document.
 */
export const generateOpenAPI = (
  info: OpenAPIInfo,
  routes: readonly RouteDefinition[],
  options: OpenAPIDocumentOptions = {},
): OpenAPIDocument => {
  const document = pipe(routes)(
    (input) => skipUnroutable(input, options),
    groupByPath,
    hoistComponents,
    buildDocument(info, options),
  );
  return transformDocument(document, options);
};
