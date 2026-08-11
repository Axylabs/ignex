/**
 * Phase 2: Validator Precompilation
 *
 * Emits Ajv standalone validators for route schemas.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { DiagnosticCodes, errorMessage } from "../diagnostics";
import type { CompilerContext, CompilerOptions, ModuleInfo, RouteDef } from "../types";
import { cloneSchema, forEachRouteWithSchema, isStandardSchema } from "./schema-loader";

const VALIDATOR_KINDS = ["body", "query", "params", "headers", "cookie"] as const;

type ValidatorKind = (typeof VALIDATOR_KINDS)[number];

const validatorImportName = (route: RouteDef, kind: ValidatorKind): string =>
  `validate_${route.handlerRef}_${kind}`;

const validatorFileName = (route: RouteDef, kind: ValidatorKind): string =>
  `${route.handlerRef}.${kind}.cjs`;

export const precompileValidators = async (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  opts: CompilerOptions,
  ctx: CompilerContext,
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
    ctx.diagnostics.warn({
      code: DiagnosticCodes.ValidatorCompileFailed,
      message:
        "Ajv standalone unavailable. Validator precompilation skipped; falling back to runtime validation.",
    });
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

  const compileSchemaPart = (
    schemaPart: unknown,
    onFail?: (reason: string) => void,
  ): string | null => {
    if (!schemaPart || typeof schemaPart !== "object") {
      return null;
    }

    if (isStandardSchema(schemaPart)) {
      return null;
    }

    let cloned: any;

    try {
      cloned = cloneSchema(schemaPart);
    } catch (error) {
      onFail?.(`schema clone failed: ${errorMessage(error)}`);
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
    } catch (error) {
      onFail?.(`Ajv compile failed: ${errorMessage(error)}`);
      return null;
    }
  };

  return forEachRouteWithSchema(
    routes,
    modules,
    ctx,
    (route) => route.hasValidation,
    async (route, mod, schemaDoc) => {
      const validators: Record<string, string> = {};

      for (const kind of VALIDATOR_KINDS) {
        const schemaPart = schemaDoc[kind];

        if (!schemaPart) {
          continue;
        }

        const code = compileSchemaPart(schemaPart, (reason) => {
          ctx.diagnostics.warn({
            code: DiagnosticCodes.ValidatorCompileFailed,
            message: `Validator precompilation failed for ${route.method} ${route.path} (${kind}); falling back to runtime validation. ${reason}`,
            file: mod.path,
          });
        });

        if (!code) {
          continue;
        }

        const file = validatorFileName(route, kind);
        writeFileSync(join(validatorsDir, file), code);

        validators[kind] = validatorImportName(route, kind);
      }

      if (Object.keys(validators).length > 0) {
        ctx.logger.info(`Precompiled validators for ${route.method} ${route.path}`);
      }

      // Keep the resolved schema on the route so OpenAPI generation can emit
      // real request/response schemas even when no validator compiled.
      return {
        ...route,
        ...(Object.keys(validators).length > 0 ? { validators: validators as any } : {}),
        schemaDoc,
      };
    },
  );
};
