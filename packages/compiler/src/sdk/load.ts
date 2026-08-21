/**
 * @fileoverview SDK input loading: compiled artifacts → route inputs.
 *
 * The SDK is derived from what the compiler already emits for a built app —
 * `manifest.json` (per-route usage metadata) and `openapi.json` (the canonical
 * OpenAPI 3.1 document with real request/response schemas). This keeps the SDK
 * in lockstep with the served API: whatever `ignex build` produced is exactly
 * what the SDK describes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SdkRouteInfo } from "./types";

/** Shape of a `manifest.json` route entry (the fields the SDK reads). */
interface ManifestRoute {
  method: string;
  path: string;
  paramNames?: readonly string[];
  responseType?: string;
  usage?: { body?: boolean; query?: boolean };
}

/** Shape of the `manifest.json` root. */
interface ManifestDoc {
  serviceName?: string;
  routes?: readonly ManifestRoute[];
}

/** Manifest path (`/reports/:id`) → OpenAPI path key (`/reports/{id}`). */
const toOpenApiPath = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\*([A-Za-z0-9_]+)/g, "{$1}");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Merge path/query OpenAPI parameters into a single object schema. */
const parametersToSchema = (
  parameters: unknown,
  location: "path" | "query",
): Record<string, unknown> | undefined => {
  if (!Array.isArray(parameters)) return undefined;
  const selected = parameters.filter(
    (p): p is Record<string, unknown> => isRecord(p) && p.in === location && isRecord(p.schema),
  );
  if (selected.length === 0) return undefined;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of selected) {
    const name = typeof param.name === "string" ? param.name : "";
    if (name === "") continue;
    properties[name] = param.schema;
    if (param.required === true) required.push(name);
  }
  if (Object.keys(properties).length === 0) return undefined;
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
};

/** The first 2xx response's JSON schema, if the operation documents one. */
const responseSchemaOf = (responses: unknown): unknown => {
  if (!isRecord(responses)) return undefined;
  const statuses = Object.keys(responses)
    .filter((key) => /^2\d\d$/.test(key))
    .sort();
  for (const status of statuses) {
    const response = responses[status];
    if (!isRecord(response)) continue;
    const content = response.content;
    if (!isRecord(content)) continue;
    for (const mediaType of Object.keys(content)) {
      if (!mediaType.includes("json")) continue;
      const media = content[mediaType];
      if (isRecord(media) && media.schema !== undefined) return media.schema;
    }
  }
  return undefined;
};

/** The request body JSON schema of an operation, if documented. */
const bodySchemaOf = (op: Record<string, unknown> | undefined): unknown => {
  const requestBody = isRecord(op?.requestBody) ? op.requestBody : undefined;
  const content = isRecord(requestBody?.content) ? requestBody.content : undefined;
  if (content === undefined) return undefined;
  for (const mediaType of Object.keys(content)) {
    if (!mediaType.includes("json")) continue;
    const media = content[mediaType];
    if (isRecord(media) && media.schema !== undefined) return media.schema;
  }
  return undefined;
};

/** The OpenAPI operation object for a manifest route entry, if any. */
const operationOf = (
  paths: Record<string, unknown>,
  entry: ManifestRoute,
): Record<string, unknown> | undefined => {
  const method = (entry.method ?? "").toLowerCase();
  const pathDoc: unknown = paths[toOpenApiPath(entry.path)];
  const operation: Record<string, unknown> | undefined = isRecord(pathDoc) ? pathDoc : undefined;
  const opDoc: unknown = operation !== undefined ? operation[method] : undefined;
  return isRecord(opDoc) ? opDoc : undefined;
};

/** Build one {@link SdkRouteInfo} from a manifest entry + its operation. */
const routeInput = (
  entry: ManifestRoute,
  op: Record<string, unknown> | undefined,
): SdkRouteInfo => {
  const bodySchema = bodySchemaOf(op);
  const paramsSchema = parametersToSchema(op?.parameters, "path");
  const querySchema = parametersToSchema(op?.parameters, "query");
  const responseSchema = responseSchemaOf(op?.responses);

  return {
    method: entry.method ?? "GET",
    path: entry.path,
    paramNames: entry.paramNames ?? [],
    usesBody: entry.usage?.body === true || bodySchema !== undefined,
    usesQuery: entry.usage?.query === true,
    ...(bodySchema !== undefined ? { bodySchema } : {}),
    ...(paramsSchema !== undefined ? { paramsSchema } : {}),
    ...(querySchema !== undefined ? { querySchema } : {}),
    ...(responseSchema !== undefined ? { responseSchema } : {}),
    responseType: entry.responseType ?? "unknown",
  };
};

/**
 * Load the compiled SDK inputs from an artifact directory.
 *
 * @param outDir - Directory holding `manifest.json` + `openapi.json`
 * (the compiler's output directory).
 * @returns The resolved routes, the OpenAPI document, and the service name.
 */
export const loadSdkInputs = (
  outDir: string,
): { routes: readonly SdkRouteInfo[]; openapi: Record<string, unknown>; serviceName: string } => {
  const manifestPath = join(outDir, "manifest.json");
  const openapiPath = join(outDir, "openapi.json");

  let manifest: ManifestDoc;
  let openapi: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestDoc;
    openapi = JSON.parse(readFileSync(openapiPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Cannot load SDK inputs from ${outDir} — run \`ignex build\` first so manifest.json and ` +
        `openapi.json exist there. (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const paths = isRecord(openapi.paths) ? openapi.paths : {};
  const routes = (manifest.routes ?? []).map((entry) =>
    routeInput(entry, operationOf(paths, entry)),
  );

  return {
    routes,
    openapi,
    serviceName: typeof manifest.serviceName === "string" ? manifest.serviceName : "ignex",
  };
};
