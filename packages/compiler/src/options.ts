/**
 * @fileoverview Compiler runtime options — default options, optimization
 * presets, HTTP-method vocabulary, and schema-part ordering.
 *
 * Split from `./types` so the type definitions stay pure (types-only) and the
 * runtime defaults/presets live in one focused module. `types.ts` re-exports
 * these so existing `from "../types"` imports keep working unchanged.
 */

import { FULL_USAGE } from "@ignex/shared";
import type { CompilerOptions, HttpMethod } from "./types";

/** A `ContextUsage` with every capability enabled (frozen). */
export const FULL_CONTEXT_USAGE = FULL_USAGE;

/** Method-name aliases accepted by route-file suffixes (`DEL` → `DELETE`). */
export const HTTP_METHOD_ALIASES: Record<string, HttpMethod> = {
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  PATCH: "PATCH",
  DELETE: "DELETE",
  DEL: "DELETE",
  HEAD: "HEAD",
  OPTIONS: "OPTIONS",
  ALL: "ALL",
};

/**
 * Normalize a method string to a canonical {@link HttpMethod} (or `undefined`
 * when unknown). Case-insensitive; honors the {@link HTTP_METHOD_ALIASES}.
 */
export function normalizeHttpMethod(input: string): HttpMethod | undefined {
  return HTTP_METHOD_ALIASES[input.toUpperCase()];
}

/** The optimization preset level (0–3); see {@link optimizationPresets}. */
export type OptimizationLevel = 0 | 1 | 2 | 3;

/**
 * Documented optimization presets. Each level is a group of optimizer knobs;
 * explicit user options always override the preset (preset is applied to the
 * defaults, then user options are merged on top).
 */
export const optimizationPresets: Record<OptimizationLevel, Partial<CompilerOptions>> = {
  0: {
    optimizationLevel: 0,
    inlineThreshold: 0,
    enableHandlerDeduplication: false,
    precompileValidators: false,
    precompileSerializers: false,
    hoistConstants: false,
    specializeContext: false,
    routeCache: false,
    generateTypes: false,
    generateOpenAPI: false,
    generateClient: false,
    incremental: false,
  },
  1: {
    optimizationLevel: 1,
    inlineThreshold: 30,
    enableHandlerDeduplication: true,
    precompileValidators: false,
    precompileSerializers: false,
    hoistConstants: false,
    specializeContext: false,
    routeCache: false,
  },
  2: {
    optimizationLevel: 2,
    inlineThreshold: 50,
    enableHandlerDeduplication: true,
    precompileValidators: false,
    precompileSerializers: false,
    nativeRoutes: true,
    hoistConstants: true,
    specializeContext: true,
    routeCache: true,
  },
  3: {
    optimizationLevel: 3,
    inlineThreshold: 50,
    enableHandlerDeduplication: true,
    precompileValidators: true,
    precompileSerializers: true,
    nativeRoutes: true,
    hoistConstants: true,
    specializeContext: true,
    routeCache: true,
    incremental: true,
  },
};

/** Build the fully-defaulted {@link CompilerOptions} (env-aware). */
export const createDefaultOptions = (): CompilerOptions => ({
  routesDir: process.env.ROUTES_DIR || "./src/routes",
  appConfig: process.env.APP_CONFIG || "./src/app.config.ts",
  // NOTE: no `maxRequestBodySize` literal here — the emitted bootstrap falls
  // back to the shared core constant (DEFAULT_MAX_REQUEST_BODY_SIZE, 64MB) so
  // the compiled server and the interpreted `serve()` enforce the SAME
  // deliberate ceiling. Set this option explicitly to override.
  strictRouteConflicts: false,
  validateCookies: true,
  outDir: process.env.OUT_DIR || "./.ignex",
  outFile: process.env.OUT_FILE || "server.js",
  target: "bun",

  optimizationLevel: 3,
  inlineThreshold: 50,
  enableHandlerDeduplication: true,
  // Source maps ON by default: the debugbar's stack/origin remapper
  // (packages/core/src/debug/sourcemaps.ts) needs `<out>.js.map` next to the
  // bundle to translate frames back to src/*.ts. Disable only when artifact
  // size matters more than debuggability.
  sourceMap: true,
  minify: false,
  verbose: false,

  enableAccessLog: false,
  enableTraceHeaders: false,

  serviceName: "ignex",
  exposeErrorDetails: process.env.NODE_ENV !== "production",

  generateTypes: true,
  generateOpenAPI: true,
  generateClient: true,

  precompileValidators: true,
  precompileSerializers: true,
  nativeRoutes: true,

  hoistConstants: true,
  specializeContext: true,
  routeCache: true,
  incremental: true,

  maxInlineBytes: 2048,
  heatCapture: false,
});

/** The default {@link CompilerOptions} (see {@link createDefaultOptions}). */
export const DEFAULT_OPTS: CompilerOptions = createDefaultOptions();

/**
 * The five validate-able schema parts, in canonical (validator-generation)
 * order. Single source of truth for the part list — precompilation
 * (`validators.ts`) and codegen import assembly (`codegen/imports.ts`) both
 * iterate it. NOTE: codegen's validation PRELUDE uses a different emission
 * order (`params` first) — see `codegen/routes/validate.ts` `PART_KINDS`.
 */
export const SCHEMA_PARTS = ["body", "query", "params", "headers", "cookie"] as const;
