/**
 * Phase 2: Validator Precompilation
 *
 * Emits Ajv standalone validators for route schemas.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

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

const VALIDATOR_KINDS = ["body", "query", "params", "headers", "cookie"] as const;

type ValidatorKind = (typeof VALIDATOR_KINDS)[number];

const validatorImportName = (
  route: RouteDef,
  kind: ValidatorKind
): string => `validate_${route.handlerRef}_${kind}`;

const validatorFileName = (
  route: RouteDef,
  kind: ValidatorKind
): string => `${route.handlerRef}.${kind}.cjs`;

export const precompileValidators = async (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  opts: CompilerOptions,
  logger: Logger
): Promise<readonly RouteDef[]> => {
  if (!opts.precompileValidators) {
    return routes;
  }

  const validatorsDir = join(opts.outDir, "validators");
  mkdirSync(validatorsDir, { recursive: true });

  let standaloneCode: any;

  try {
    const standaloneModule: any = await import("ajv/dist/standalone/index.js");
    standaloneCode = standaloneModule.default ?? standaloneModule;
  } catch {
    logger.warn(
      "Ajv standalone unavailable. Validator precompilation will be skipped."
    );
    return routes;
  }

  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    coerceTypes: true,
    removeAdditional: true,
    useDefaults: true,
    code: {
      source: true,
      esm: false,
    },
  });

  addFormats(ajv);

  const compileSchemaPart = (schemaPart: unknown): string | null => {
    if (!schemaPart || typeof schemaPart !== "object") {
      return null;
    }

    if (isStandardSchema(schemaPart)) {
      return null;
    }

    let cloned: any;

    try {
      cloned = cloneSchema(schemaPart);
    } catch {
      return null;
    }

    if (!cloned || typeof cloned !== "object") {
      return null;
    }

    if (cloned.noValidate === true) {
      return null;
    }

    delete cloned.$id;

    try {
      const validate = ajv.compile(cloned);
      const code = standaloneCode(ajv, validate);

      return `${code}
try {
  if (typeof module !== "undefined" && module.exports && typeof module.exports === "function") {
    module.exports.default = module.exports;
  }
} catch {}
`;
    } catch {
      return null;
    }
  };

  const nextRoutes: RouteDef[] = [];

  for (const route of routes) {
    if (!route.hasValidation) {
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

    const validators: Record<string, string> = {};

    for (const kind of VALIDATOR_KINDS) {
      const schemaPart = schema[kind];

      if (!schemaPart) {
        continue;
      }

      const code = compileSchemaPart(schemaPart);

      if (!code) {
        continue;
      }

      const file = validatorFileName(route, kind);
      writeFileSync(join(validatorsDir, file), code);

      validators[kind] = validatorImportName(route, kind);
    }

    if (Object.keys(validators).length === 0) {
      nextRoutes.push(route);
      continue;
    }

    nextRoutes.push({
      ...route,
      validators: validators as any,
    });

    logger.info(`Precompiled validators for ${route.method} ${route.path}`);
  }

  return nextRoutes;
};
