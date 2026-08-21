/**
 * @fileoverview OpenAPI 3.1 generator types — the public contract consumed by
 * `@ignex/core` (runtime docs) and `@ignex/compiler` (generated openapi.json).
 */

import type { HttpMethod } from "../http";

/** Top-level OpenAPI document metadata (`info` block). */
export interface OpenAPIInfo {
  title: string;
  version: string;
  description?: string;
}

/** Schema parts accepted per route (shape-compatible with core's `RouteSchema`). */
export interface OpenAPIRouteSchema {
  body?: unknown;
  headers?: unknown;
  query?: unknown;
  params?: unknown;
  cookie?: unknown;
  response?: unknown;
}

/**
 * A route as the OpenAPI generator consumes it: one HTTP operation.
 *
 * This is the compiler↔shared contract — `@ignex/compiler` maps its internal
 * route IR onto this shape before calling {@link generateOpenAPI}.
 */
export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  schema?: OpenAPIRouteSchema;
  /** Arbitrary operation decoration (summary/tags/security/…). */
  detail?: Record<string, unknown>;
  /** Path parameter names — fallback when `schema.params` is absent. */
  paramNames?: readonly string[];
  /** Set when the handler reads the request body even without a body schema. */
  usesBody?: boolean;
}

/**
 * An OpenAPI 3.1 document as produced by {@link generateOpenAPI}.
 *
 * Typed as a record rather than a strict interface so consumers can read and
 * extend it freely; the structure follows the OpenAPI 3.1.0 spec.
 */
export type OpenAPIDocument = Record<string, unknown>;

/** Where an OpenAPI parameter appears in the request. */
export type ParameterLocation = "path" | "query" | "header" | "cookie";

/**
 * A single OpenAPI parameter object (`in: path | query | header | cookie`).
 *
 * `schema` is the JSON Schema describing the parameter value, with `$id`
 * stripped (it must be unique per document).
 */
export interface ParameterDoc {
  name: string;
  in: ParameterLocation;
  required: boolean;
  schema: unknown;
  description?: string;
  deprecated?: boolean;
  example?: unknown;
}
