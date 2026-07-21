/**
 * Compiler options validation.
 *
 * Updated for AOT compiler options.
 */

import { Type, type Static } from "@sinclair/typebox";
import Ajv from "ajv";
import type { CompilerOptions } from "./types";
import { DEFAULT_OPTS } from "./types";
import type { Result } from "./fp";
import { ok, err } from "./fp";

const CompilerOptionsSchema = Type.Object(
  {
    routesDir: Type.String({ minLength: 1 }),
    outDir: Type.String({ minLength: 1 }),
    outFile: Type.String({ minLength: 1 }),

    appConfig: Type.Optional(Type.String({ minLength: 1 })),
    maxRequestBodySize: Type.Optional(Type.Integer({ minimum: 0 })),
    strictRouteConflicts: Type.Optional(Type.Boolean()),
    validateCookies: Type.Optional(Type.Boolean()),

    target: Type.Union([
      Type.Literal("bun"),
    ]),

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

    enableTracing: Type.Optional(Type.Boolean()),
    enableAccessLog: Type.Optional(Type.Boolean()),
    enableTraceHeaders: Type.Optional(Type.Boolean()),
    enableLifecycle: Type.Optional(Type.Boolean()),
    enableStrictMethods: Type.Optional(Type.Boolean()),
    enableFastBodyParsing: Type.Optional(Type.Boolean()),

    serviceName: Type.Optional(Type.String({ minLength: 1 })),
    requestIdHeader: Type.Optional(Type.String({ minLength: 1 })),
    exposeErrorDetails: Type.Optional(Type.Boolean()),

    maxJsonBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    maxTextBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    maxFormBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    maxFileBytes: Type.Optional(Type.Integer({ minimum: 0 })),

    cluster: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("auto")])
    ),

    reusePort: Type.Optional(Type.Boolean()),

    router: Type.Optional(
      Type.Union([
        Type.Literal("auto"),
        Type.Literal("static-map"),
        Type.Literal("radix"),
        Type.Literal("bun-native"),
      ])
    ),

    generateTypes: Type.Optional(Type.Boolean()),
    generateOpenAPI: Type.Optional(Type.Boolean()),
    generateClient: Type.Optional(Type.Boolean()),

    precompileValidators: Type.Optional(Type.Boolean()),
    precompileSerializers: Type.Optional(Type.Boolean()),

    hoistConstants: Type.Optional(Type.Boolean()),
    specializeContext: Type.Optional(Type.Boolean()),
    inlineHooks: Type.Optional(Type.Boolean()),
    treeshakeRuntime: Type.Optional(Type.Boolean()),
    routeCache: Type.Optional(Type.Boolean()),

    maxInlineBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false }
);

export type ValidatedCompilerOptions = Static<typeof CompilerOptionsSchema>;

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  useDefaults: true,
  coerceTypes: false,
});

const validate = ajv.compile(CompilerOptionsSchema);

export const validateOptions = (
  input: Partial<CompilerOptions>
): Result<CompilerOptions, string[]> => {
  const data = { ...DEFAULT_OPTS, ...input };

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
