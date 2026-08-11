/**
 * Compiler options validation.
 *
 * - Validates options against a TypeBox schema (rejects unknown keys).
 * - Recognizes previously-supported options that have been removed and emits a
 *   `FLX_OPTION_DEPRECATED` warning instead of silently ignoring them.
 * - Emits `FLX_OPTION_UNKNOWN` for truly unknown keys.
 */

import { type Static, Type } from "@sinclair/typebox";
import Ajv from "ajv";
import { defu } from "defu";
import { DiagnosticCodes, type DiagnosticCollector } from "./diagnostics";
import type { Result } from "./fp";
import { err, ok } from "./fp";
import type { CompilerOptions } from "./types";
import { DEFAULT_OPTS, type OptimizationLevel, optimizationPresets } from "./types";

const CompilerOptionsSchema = Type.Object(
  {
    routesDir: Type.String({ minLength: 1 }),
    outDir: Type.String({ minLength: 1 }),
    outFile: Type.String({ minLength: 1 }),

    appConfig: Type.Optional(Type.String({ minLength: 1 })),
    maxRequestBodySize: Type.Optional(Type.Integer({ minimum: 0 })),
    strictRouteConflicts: Type.Optional(Type.Boolean()),
    validateCookies: Type.Optional(Type.Boolean()),

    target: Type.Union([Type.Literal("bun")]),

    optimizationLevel: Type.Union([
      Type.Literal(0),
      Type.Literal(1),
      Type.Literal(2),
      Type.Literal(3),
    ]),

    inlineThreshold: Type.Number({ minimum: 0, maximum: 1000 }),
    enableHandlerDeduplication: Type.Boolean(),
    sourceMap: Type.Boolean(),
    minify: Type.Boolean(),

    hooksDir: Type.Optional(Type.String({ minLength: 1 })),

    verbose: Type.Optional(Type.Boolean()),
    enableAccessLog: Type.Optional(Type.Boolean()),
    enableTraceHeaders: Type.Optional(Type.Boolean()),

    serviceName: Type.Optional(Type.String({ minLength: 1 })),
    exposeErrorDetails: Type.Optional(Type.Boolean()),

    maxJsonBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    maxTextBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    maxFormBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    maxFileBytes: Type.Optional(Type.Integer({ minimum: 0 })),

    reusePort: Type.Optional(Type.Boolean()),

    generateTypes: Type.Optional(Type.Boolean()),
    generateOpenAPI: Type.Optional(Type.Boolean()),
    generateClient: Type.Optional(Type.Boolean()),

    precompileValidators: Type.Optional(Type.Boolean()),
    precompileSerializers: Type.Optional(Type.Boolean()),

    hoistConstants: Type.Optional(Type.Boolean()),
    specializeContext: Type.Optional(Type.Boolean()),
    treeshakeRuntime: Type.Optional(Type.Boolean()),
    routeCache: Type.Optional(Type.Boolean()),

    incremental: Type.Optional(Type.Boolean()),

    maxInlineBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

/**
 * Options that were supported in earlier versions and have been removed.
 * They are accepted with a deprecation warning and ignored, so existing
 * configs do not hard-fail.
 */
const DEPRECATED_OPTIONS: Record<string, string> = {
  router: "Flux always emits Bun's native router. Remove this option.",
  cluster:
    "Cluster mode is configured at the runtime/Bun level, not the compiler. Remove this option.",
  inlineHooks: "Hooks are always invoked at runtime. Remove this option.",
};

const SCHEMA_KEYS = new Set(Object.keys((CompilerOptionsSchema as any).properties ?? {}));

export type ValidatedCompilerOptions = Static<typeof CompilerOptionsSchema>;

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  useDefaults: true,
  coerceTypes: false,
});

const validate = ajv.compile(CompilerOptionsSchema);

/**
 * Merge partial compiler options with defaults + the optimization preset.
 * Single source of truth for preset application — `validateOptions` validates
 * the result produced here.
 */
export const mergeOptions = (opts: Partial<CompilerOptions>): CompilerOptions => {
  // Apply the optimization preset for the requested level to the defaults, then
  // let explicit user knobs win over both (defu: earlier args override later).
  const level = (opts.optimizationLevel ?? DEFAULT_OPTS.optimizationLevel) as OptimizationLevel;
  const preset = optimizationPresets[level] ?? {};
  const base = defu(preset, DEFAULT_OPTS) as CompilerOptions;
  return defu(opts, base) as CompilerOptions;
};

export const validateOptions = (
  input: Partial<CompilerOptions>,
  diagnostics?: DiagnosticCollector,
): Result<CompilerOptions, string[]> => {
  // Defaults + optimization preset are merged once (see `mergeOptions`); this
  // function only validates the merged result and warns on removed/unknown keys.
  const data: Record<string, unknown> = { ...mergeOptions(input) };

  // Handle removed and unknown options before schema validation.
  for (const key of Object.keys(input)) {
    if (key in DEPRECATED_OPTIONS) {
      diagnostics?.warn({
        code: DiagnosticCodes.OptionDeprecated,
        message: `Option '${key}' is deprecated and ignored. ${DEPRECATED_OPTIONS[key]}`,
      });
      delete data[key];
      continue;
    }

    if (!SCHEMA_KEYS.has(key)) {
      diagnostics?.error({
        code: DiagnosticCodes.OptionUnknown,
        message: `Unknown compiler option: '${key}'`,
      });
    }
  }

  if (validate(data)) {
    return ok(data as CompilerOptions);
  }

  const errors = (validate.errors ?? []).map((e) => {
    const path =
      e.instancePath?.replace(/^\//, "").replace(/\//g, ".") ||
      (e.params as any)?.missingProperty ||
      "options";

    return `${path}: ${e.message}`;
  });

  return err(errors);
};
