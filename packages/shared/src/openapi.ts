/**
 * @fileoverview OpenAPI 3.1 Specification Generator (shared).
 *
 * Lives in `@ignus/shared` — the compiler ↔ runtime contract vocabulary — so
 * `@ignus/core` (runtime docs) and `@ignus/compiler` (generated openapi.json)
 * share ONE implementation with zero cross-package import risk. `shared` has
 * no runtime dependencies, so this module is importable from anywhere.
 *
 * The generator is a pure, composed pipeline (`pipe` over named stages) so
 * each concern — path conversion, parameter shaping, response mapping,
 * component hoisting — is a small, independently testable function.
 */

import { pipe } from "./fp";
import type { HttpMethod } from "./http";

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

export type OpenAPIDocument = Record<string, unknown>;

// ── type guards ─────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasProperties = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && isRecord(value.properties);

/** The `properties` record of an object schema, if present. */
const propertiesOf = (schema: unknown): Record<string, unknown> | undefined =>
  hasProperties(schema) ? (schema.properties as Record<string, unknown>) : undefined;

/** `{ "200": schema, "404": schema }` style response maps. */
const isStatusMap = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => /^\d{3}$/.test(key));
};

const requiredOf = (schema: unknown): readonly string[] => {
  if (!isRecord(schema)) return [];
  const required = schema.required;
  return Array.isArray(required)
    ? required.filter((entry): entry is string => typeof entry === "string")
    : [];
};

// ── schema shaping ──────────────────────────────────────────────

/** Clone a schema, dropping `$id` (which must be unique per document). */
const stripId = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripId);
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$id") continue;
    next[key] = stripId(child);
  }
  return next;
};

const toOpenApiPath = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\*([A-Za-z0-9_]+)/g, "{$1}");

const operationIdFor = (method: string, openApiPath: string): string =>
  `${method.toLowerCase()}_${openApiPath.replace(/[{}/]/g, "_")}`;

// ── parameters ──────────────────────────────────────────────────

type ParameterLocation = "path" | "query" | "header" | "cookie";

export interface ParameterDoc {
  name: string;
  in: ParameterLocation;
  required: boolean;
  schema: unknown;
  description?: string;
  deprecated?: boolean;
  example?: unknown;
}

const toParameter = (
  name: string,
  location: ParameterLocation,
  propSchema: unknown,
  required: boolean,
): ParameterDoc => {
  const prop = isRecord(propSchema) ? propSchema : {};
  const param: ParameterDoc = {
    name,
    in: location,
    required,
    schema: stripId(propSchema),
  };
  if (typeof prop.description === "string") param.description = prop.description;
  if (prop.deprecated === true) param.deprecated = true;
  if ("example" in prop) param.example = prop.example;
  return param;
};

const parametersFrom = (
  schema: unknown,
  location: ParameterLocation,
  requiredOverride?: readonly string[],
): readonly ParameterDoc[] => {
  const properties = propertiesOf(schema);
  if (properties === undefined) return [];
  const required = new Set(requiredOf(schema).concat(requiredOverride ?? []));
  return Object.entries(properties).map(([name, propSchema]) =>
    toParameter(name, location, propSchema, location === "path" || required.has(name)),
  );
};

/** Path params fallback when no `schema.params` is attached. */
const pathParamFallback = (route: RouteDefinition): readonly ParameterDoc[] => {
  if (route.paramNames == null || route.paramNames.length === 0) return [];
  return route.paramNames.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
};

/** De-duplicate parameters by `in:name` (first occurrence wins). */
const mergeParameters = (lists: readonly (readonly ParameterDoc[])[]): readonly ParameterDoc[] => {
  const seen = new Set<string>();
  const merged: ParameterDoc[] = [];
  for (const list of lists) {
    for (const param of list) {
      const key = `${param.in}:${param.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(param);
    }
  }
  return merged;
};

// ── requestBody / responses ─────────────────────────────────────

const requestBodyFor = (
  schema: unknown,
  usesBody: boolean,
): Record<string, unknown> | undefined => {
  if (schema == null && !usesBody) return undefined;
  return {
    required: schema != null,
    content: {
      "application/json": { schema: schema == null ? { type: "object" } : stripId(schema) },
    },
  };
};

const STATUS_DESCRIPTIONS: Record<string, string> = {
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "204": "No Content",
  "206": "Partial Content",
  "301": "Moved Permanently",
  "302": "Found",
  "304": "Not Modified",
  "400": "Bad Request",
  "401": "Unauthorized",
  "403": "Forbidden",
  "404": "Not Found",
  "405": "Method Not Allowed",
  "409": "Conflict",
  "410": "Gone",
  "413": "Payload Too Large",
  "415": "Unsupported Media Type",
  "422": "Unprocessable Entity",
  "429": "Too Many Requests",
  "500": "Internal Server Error",
  "501": "Not Implemented",
  "502": "Bad Gateway",
  "503": "Service Unavailable",
  "504": "Gateway Timeout",
};

const statusDescription = (status: string): string => STATUS_DESCRIPTIONS[status] ?? "Response";

const responsesFor = (responseSchema: unknown): Record<string, unknown> => {
  if (responseSchema == null) {
    return { "200": { description: "Successful response" } };
  }
  if (isStatusMap(responseSchema)) {
    return Object.fromEntries(
      Object.entries(responseSchema).map(([status, schema]) => [
        status,
        {
          description: statusDescription(status),
          content: { "application/json": { schema: stripId(schema) } },
        },
      ]),
    );
  }
  return {
    "200": {
      description: "Successful response",
      content: { "application/json": { schema: stripId(responseSchema) } },
    },
  };
};

// ── operation ───────────────────────────────────────────────────

interface OperationModel {
  method: string;
  openApiPath: string;
  operation: Record<string, unknown>;
}

const operationFor = (route: RouteDefinition): OperationModel => {
  const openApiPath = toOpenApiPath(route.path);
  const { schema, detail } = route;

  const pathParams = hasProperties(schema?.params)
    ? parametersFrom(schema?.params, "path", route.paramNames)
    : pathParamFallback(route);

  const parameters = mergeParameters([
    pathParams,
    parametersFrom(schema?.query, "query"),
    parametersFrom(schema?.headers, "header"),
    parametersFrom(schema?.cookie, "cookie"),
  ]);

  const operation: Record<string, unknown> = {
    operationId: operationIdFor(route.method, openApiPath),
    ...detail,
    responses: responsesFor(schema?.response),
  };

  if (parameters.length > 0) {
    operation.parameters = parameters;
  }

  const requestBody = requestBodyFor(schema?.body, route.usesBody === true);
  if (requestBody) {
    operation.requestBody = requestBody;
  }

  return { method: route.method.toLowerCase(), openApiPath, operation };
};

// ── components ($defs → components.schemas) ─────────────────────

type SchemaRegistry = Record<string, unknown>;

/**
 * Hoist `$defs` into `components.schemas` and rewrite `#/$defs/<name>` refs
 * to `#/components/schemas/<name>` (the OpenAPI tooling convention). Runs over
 * the finished document so nested `$defs` from TypeBox/JSON Schema are
 * collected once and de-duplicated by name (first wins).
 */
const hoistDefs = (value: unknown, schemas: SchemaRegistry): unknown => {
  if (Array.isArray(value)) return value.map((item) => hoistDefs(item, schemas));
  if (!isRecord(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$defs" && isRecord(child)) {
      for (const [name, def] of Object.entries(child)) {
        schemas[name] ??= def;
      }
      continue;
    }
    if (key === "$ref" && typeof child === "string") {
      const ref = /^#\/\$defs\/(.+)$/.exec(child);
      if (ref) {
        next[key] = `#/components/schemas/${ref[1]}`;
        continue;
      }
    }
    next[key] = hoistDefs(child, schemas);
  }
  return next;
};

// ── the pipeline ────────────────────────────────────────────────

/** `ALL`/`WS` routes aren't documentable operations — drop them up front. */
const skipUnroutable = (routes: readonly RouteDefinition[]): readonly RouteDefinition[] =>
  routes.filter((route) => route.method !== "ALL" && route.method !== "WS");

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

interface DocState {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: SchemaRegistry };
}

const hoistComponents = (paths: DocState["paths"]): DocState => {
  const schemas: SchemaRegistry = {};
  const hoisted: DocState["paths"] = {};
  for (const [openApiPath, methods] of Object.entries(paths)) {
    const next: Record<string, Record<string, unknown>> = {};
    for (const [method, operation] of Object.entries(methods)) {
      next[method] = hoistDefs(operation, schemas) as Record<string, unknown>;
    }
    hoisted[openApiPath] = next;
  }
  return { paths: hoisted, components: { schemas } };
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
    return document;
  };

export const generateOpenAPI = (
  info: OpenAPIInfo,
  routes: readonly RouteDefinition[],
): OpenAPIDocument =>
  pipe(routes)(skipUnroutable, groupByPath, hoistComponents, buildDocument(info));
