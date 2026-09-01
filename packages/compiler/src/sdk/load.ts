/**
 * @fileoverview SDK input loading: compiled artifacts → route inputs.
 *
 * The SDK is derived from what the compiler already emits for a built app —
 * `manifest.json` (per-route usage metadata) and `openapi.json` (the canonical
 * OpenAPI 3.1 document with real request/response schemas). This keeps the SDK
 * in lockstep with the served API: whatever `ignex build` produced is exactly
 * what the SDK describes.
 *
 * Realtime declarations are loaded the same way when present:
 * `<outDir>/realtime.json` (written by `ignex build` from the app's
 * `src/realtime.ts`) optionally merged with `<outDir>/rpc-manifest.json`
 * (written by the runtime RPC kit).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SdkRealtimeInput, SdkRouteInfo } from "./types";

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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Read a JSON artifact that may not exist. Returns `undefined` for a missing
 * file and throws a clear error for unreadable or malformed files.
 */
const readOptionalJson = (dir: string, file: string): unknown => {
  let raw: string;
  try {
    raw = readFileSync(join(dir, file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${file} in ${dir}: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `${file} in ${dir} is not valid JSON — regenerate it via \`ignex build\`. (${errorMessage(error)})`,
    );
  }
};

/** Require an object-of-schemas field on a realtime artifact. */
const schemaRecordOf = (value: unknown, field: string, file: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${file}: "${field}" must be an object mapping names to TypeBox JSON schemas.`);
  }
  return value;
};

/**
 * Build the {@link SdkRealtimeInput} from `<outDir>/realtime.json`, merging
 * method schemas from `<outDir>/rpc-manifest.json` when present.
 *
 * @returns `undefined` when the app has no realtime declarations.
 */
export const realtimeInputOf = (outDir: string): SdkRealtimeInput | undefined => {
  const doc = readOptionalJson(outDir, "realtime.json");
  if (doc === undefined) return undefined;
  if (!isRecord(doc)) {
    throw new Error(
      `realtime.json in ${outDir} must be a plain object ({ subjectPrefix, events, schemas?, controlEvents? }).`,
    );
  }
  if (typeof doc.subjectPrefix !== "string" || doc.subjectPrefix === "") {
    throw new Error(
      `realtime.json in ${outDir} must carry a non-empty string "subjectPrefix" — regenerate via \`ignex build\` with a valid src/realtime.ts.`,
    );
  }

  const input: SdkRealtimeInput = {
    subjectPrefix: doc.subjectPrefix,
    events: schemaRecordOf(doc.events ?? {}, "events", "realtime.json"),
  };
  if (doc.schemas !== undefined) {
    input.schemas = schemaRecordOf(doc.schemas, "schemas", "realtime.json");
  }
  if (doc.controlEvents !== undefined) {
    input.controlEvents = schemaRecordOf(doc.controlEvents, "controlEvents", "realtime.json");
  }

  const manifest = readOptionalJson(outDir, "rpc-manifest.json");
  if (manifest !== undefined) {
    if (!isRecord(manifest)) {
      throw new Error(
        `rpc-manifest.json in ${outDir} must be a plain object ({ methods: { "<method.name>": <args schema> } }).`,
      );
    }
    input.rpcMethods = schemaRecordOf(manifest.methods ?? {}, "methods", "rpc-manifest.json");
  }

  return input;
};

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
 * (the compiler's output directory), plus the optional `realtime.json` /
 * `rpc-manifest.json` realtime artifacts.
 * @returns The resolved routes, the OpenAPI document, the service name, and
 * the realtime input (absent when the app declares no realtime events).
 */
export const loadSdkInputs = (
  outDir: string,
): {
  routes: readonly SdkRouteInfo[];
  openapi: Record<string, unknown>;
  serviceName: string;
  realtime?: SdkRealtimeInput;
} => {
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
  const realtime = realtimeInputOf(outDir);

  return {
    routes,
    openapi,
    serviceName: typeof manifest.serviceName === "string" ? manifest.serviceName : "ignex",
    ...(realtime !== undefined ? { realtime } : {}),
  };
};
