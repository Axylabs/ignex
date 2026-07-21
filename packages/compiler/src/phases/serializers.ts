/**
 * Phase 2: Serializer Precompilation
 *
 * Emits specialized JSON serializers for route response schemas.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import type {
  RouteDef,
  ModuleInfo,
  CompilerOptions,
} from "../types";

import type { Logger } from "../logger";
import {
  loadRouteModule,
  isStandardSchema,
  cloneSchema,
} from "./schema-loader";

const serializerImportName = (route: RouteDef): string =>
  `serialize_${route.handlerRef}`;

const serializerFileName = (route: RouteDef): string =>
  `${route.handlerRef}.200.mjs`;

const pickResponseSchema = (responseSchema: any): any => {
  if (!responseSchema || typeof responseSchema !== "object") {
    return undefined;
  }

  if (isStandardSchema(responseSchema)) {
    return responseSchema;
  }

  if ("type" in responseSchema) {
    return responseSchema;
  }

  return responseSchema[200] ?? responseSchema["200"] ?? responseSchema;
};

const getStatusSchemas = (responseSchema: any): Record<string, any> | null => {
  if (!responseSchema || typeof responseSchema !== "object") return null;

  const statusKeys = Object.keys(responseSchema).filter((k) => /^\d{3}$/.test(k));
  if (statusKeys.length === 0) return null;

  const out: Record<string, any> = {};

  for (const status of statusKeys) {
    const s = responseSchema[status];
    if (s) {
      out[status] = s;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
};

export const precompileSerializers = async (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  opts: CompilerOptions,
  logger: Logger
): Promise<readonly RouteDef[]> => {
  if (!opts.precompileSerializers) {
    return routes;
  }

  let fastJson: any;

  try {
    const mod: any = await import("fast-json-stringify");
    fastJson = mod.default ?? mod;
  } catch {
    logger.warn(
      "fast-json-stringify unavailable. Serializer precompilation will be skipped."
    );
    return routes;
  }

  const serializersDir = join(opts.outDir, "serializers");
  mkdirSync(serializersDir, { recursive: true });

  const nextRoutes: RouteDef[] = [];

  for (const route of routes) {
    const isJsonRoute =
      route.responseType === "json" || route.usage.json === true;

    if (!isJsonRoute) {
      nextRoutes.push(route);
      continue;
    }

    const mod = modules[route.moduleIdx];

    if (!mod || !mod.schemaExport) {
      nextRoutes.push(route);
      continue;
    }

    const routeModule = await loadRouteModule(mod.path);
    const schema = routeModule?.schema;

    if (!schema || typeof schema !== "object") {
      nextRoutes.push(route);
      continue;
    }

    const multiStatus = getStatusSchemas(schema.response);
    const responseSchema = pickResponseSchema(schema.response);

    if (!multiStatus && !responseSchema) {
      nextRoutes.push(route);
      continue;
    }

    const byStatus: Record<string, string> = {};
    const schemasToCompile = multiStatus ?? { "200": responseSchema };

for (const [status, statusSchema] of Object.entries(schemasToCompile)) {
  const fileName = `${route.handlerRef}.${status}.mjs`;
  const importName = `serialize_${route.handlerRef}_${status}`;

  // Standard Schema fallback: safe JSON.stringify serializer
  if (isStandardSchema(statusSchema)) {
    const code = `export default (input) => JSON.stringify(input);
`;

    writeFileSync(join(serializersDir, fileName), code);
    byStatus[status] = importName;
    continue;
  }

  let cloned: any;
  try {
    cloned = cloneSchema(statusSchema);
  } catch {
    continue;
  }

  try {
    fastJson(cloned);

    const code = `import fastJson from "fast-json-stringify";

const schema = ${JSON.stringify(cloned)};

const serialize = fastJson(schema);

export default serialize;
`;

    writeFileSync(join(serializersDir, fileName), code);
    byStatus[status] = importName;
  } catch {
    // If schema compilation fails, fall back to JSON.stringify
    const code = `export default (input) => JSON.stringify(input);
`;

    writeFileSync(join(serializersDir, fileName), code);
    byStatus[status] = importName;
  }
}

    if (Object.keys(byStatus).length === 0) {
      nextRoutes.push(route);
      continue;
    }

    nextRoutes.push({
      ...route,
      serializers: {
        json: byStatus["200"] ?? Object.values(byStatus)[0],
        byStatus,
      },
    });

    logger.info(`Precompiled serializer for ${route.method} ${route.path}`);
  }

  return nextRoutes;
};
