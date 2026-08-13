/**
 * Phase 2: Validator Precompilation
 *
 * Emits Ajv standalone validators for route schemas.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { DiagnosticCodes, errorMessage } from "../diagnostics";
import type { CompilerContext, CompilerOptions, ModuleInfo, RouteIR } from "../types";
import { writeGuarded } from "./artifacts";
import { cloneSchema, forEachRouteWithSchema, isStandardSchema } from "./schema-loader";

const VALIDATOR_KINDS = ["body", "query", "params", "headers", "cookie"] as const;

type ValidatorKind = (typeof VALIDATOR_KINDS)[number];

const validatorImportName = (route: RouteIR, kind: ValidatorKind): string =>
  `validate_${route.codegen.handlerRef}_${kind}`;

const validatorFileName = (route: RouteIR, kind: ValidatorKind): string =>
  `${route.codegen.handlerRef}.${kind}.cjs`;

export const precompileValidators = async (
  routes: readonly RouteIR[],
  modules: readonly ModuleInfo[],
  opts: CompilerOptions,
  ctx: CompilerContext,
): Promise<readonly RouteIR[]> => {
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

  /** Fresh Ajv per route: preserves `$id` (which anchors `$ref` resolution)
   * while avoiding duplicate-`$id` collisions across routes in a shared
   * instance. Schema compilation is the expensive part; instance creation is
   * negligible for a build-time tool. */
  const createAjv = (): Ajv => {
    const instance = new Ajv({
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
    addFormats(instance);
    return instance;
  };

  const compileSchemaPart = (
    ajv: Ajv,
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

    // Keep `$id` — it anchors internal `$ref` resolution. The per-route Ajv
    // instance above prevents cross-route duplicate-`$id` collisions, so we no
    // longer need to strip it (which broke relative `$ref`s).

    try {
      const validate = ajv.compile(cloned);
      const code = standaloneCode(ajv, validate);

      return `${code}
// Best-effort CJS interop so standalone Ajv output works under both
// module systems: expose the compiled validate fn as \`.default\` when running
// as CJS. The \`typeof module\` guard already skips ESM; the try/catch only
// defends against hostile \`module.exports\` shapes.
if (typeof module !== "undefined" && module.exports && typeof module.exports === "function") {
  try {
    module.exports.default = module.exports;
  } catch {
    // ignore — the validator still works without the alias.
  }
}
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
    (route) => route.analysis.hasValidation,
    async (route, mod, schemaDoc) => {
      const ajv = createAjv();
      const validators: Record<string, string> = {};

      for (const kind of VALIDATOR_KINDS) {
        const schemaPart = schemaDoc[kind];

        if (!schemaPart) {
          continue;
        }

        if (isStandardSchema(schemaPart)) {
          ctx.diagnostics.warn({
            code: DiagnosticCodes.StandardSchemaRuntime,
            message: `Standard-Schema '${kind}' for ${route.source.method} ${route.source.path} is validated at runtime (no build-time codegen for its vendor yet).`,
            file: mod.path,
          });
        }

        const code = compileSchemaPart(ajv, schemaPart, (reason) => {
          ctx.diagnostics.warn({
            code: DiagnosticCodes.ValidatorCompileFailed,
            message: `Validator precompilation failed for ${route.source.method} ${route.source.path} (${kind}); falling back to runtime validation. ${reason}`,
            file: mod.path,
          });
        });

        if (!code) {
          continue;
        }

        const file = validatorFileName(route, kind);
        writeGuarded(join(validatorsDir, file), code, ctx, file);

        validators[kind] = validatorImportName(route, kind);
      }

      if (Object.keys(validators).length > 0) {
        ctx.logger.info(`Precompiled validators for ${route.source.method} ${route.source.path}`);
      }

      // Keep the resolved schema on the route so OpenAPI generation can emit
      // real request/response schemas even when no validator compiled.
      return {
        ...route,
        decisions: {
          ...route.decisions,
          ...(Object.keys(validators).length > 0 ? { validators: validators as any } : {}),
          schemaDoc,
        },
      };
    },
  );
};
