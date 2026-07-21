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
    return undefined;
  }

  if ("type" in responseSchema) {
    return responseSchema;
  }

  return responseSchema[200] ?? responseSchema["200"] ?? responseSchema;
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

    const responseSchema = pickResponseSchema(schema.response);

    if (!responseSchema || isStandardSchema(responseSchema)) {
      nextRoutes.push(route);
      continue;
    }

    let cloned: any;

    try {
      cloned = cloneSchema(responseSchema);
    } catch {
      nextRoutes.push(route);
      continue;
    }

    try {
      // Test compile first.
      fastJson(cloned);

      const code = `import fastJson from "fast-json-stringify";

const schema = ${JSON.stringify(cloned)};

const serialize = fastJson(schema);

export default serialize;
`;

      writeFileSync(join(serializersDir, serializerFileName(route)), code);

      nextRoutes.push({
        ...route,
        serializers: {
          json: serializerImportName(route),
        },
      });

      logger.info(`Precompiled serializer for ${route.method} ${route.path}`);
    } catch {
      nextRoutes.push(route);
    }
  }

  return nextRoutes;
};
