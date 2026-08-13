/**
 * Ignex Compiler Type System
 *
 * AOT upgrade:
 * - unified ContextUsage from shared
 * - added advanced compiler options
 * - added route metadata for future validators/serializers/OpenAPI
 */

import type { ContextUsage, HttpMethod } from "@ignex/shared";
import { FULL_USAGE, HTTP_METHODS } from "@ignex/shared";
import type { Diagnostic, DiagnosticCollector } from "./diagnostics";
import type { SourceFile } from "./frontend/source-file";
import type { SourceManager } from "./frontend/source-manager";
import type { RouteIR } from "./ir/route";
import type { Logger } from "./logger";

// Re-export the canonical IR route type.
export type { RouteIR } from "./ir/route";
export type { ContextUsage, Diagnostic, Logger };
/** A `ContextUsage` with every capability enabled (frozen). */
export const FULL_CONTEXT_USAGE = FULL_USAGE;

/** Info about the discovered app config module (`src/app.config.ts`). */
export interface AppConfigInfo {
  readonly path: string;
  readonly relPath: string;
  readonly hasPlugins: boolean;
  readonly hasLifecycle: boolean;
  readonly hasServer: boolean;
}

export type { HttpMethod };
// Shared method vocabulary (single source of truth in @ignex/shared).
export { HTTP_METHODS };

/**
 * Route-filename → HTTP-method aliases (`DEL` → `DELETE`, case-insensitive).
 */
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

/**
 * The full compiler options object. Every field is validated + defaulted by
 * `validateOptions`; `Partial<CompilerOptions>` is the accepted input shape.
 */
export interface CompilerOptions {
  /**
   * Application runtime config file.
   * May export `plugins`, `lifecycle`, and `server`.
   */
  readonly appConfig?: string;

  /**
   * Bun.serve maxRequestBodySize.
   */
  readonly maxRequestBodySize?: number;

  /**
   * Throw on duplicate or ambiguous routes.
   */
  readonly strictRouteConflicts?: boolean;

  /**
   * Enable cookie validation.
   */
  readonly validateCookies?: boolean;
  readonly routesDir: string;
  readonly outDir: string;
  readonly outFile: string;
  readonly target: "bun";

  /**
   * Optimization preset (0–3). Each level maps to a documented group of
   * optimizer knobs (see {@link optimizationPresets}); explicit knob values
   * in the input always win over the preset.
   */
  readonly optimizationLevel: OptimizationLevel;
  readonly inlineThreshold: number;
  readonly enableHandlerDeduplication: boolean;
  readonly sourceMap: boolean;
  readonly minify: boolean;

  readonly hooksDir?: string;

  readonly verbose?: boolean;
  readonly enableAccessLog?: boolean;
  readonly enableTraceHeaders?: boolean;

  readonly serviceName?: string;
  readonly exposeErrorDetails?: boolean;

  readonly maxJsonBytes?: number;
  readonly maxTextBytes?: number;
  readonly maxFormBytes?: number;
  readonly maxFileBytes?: number;

  readonly reusePort?: boolean;

  // Advanced AOT options
  readonly generateTypes?: boolean;
  readonly generateOpenAPI?: boolean;
  readonly generateClient?: boolean;

  readonly precompileValidators?: boolean;
  readonly precompileSerializers?: boolean;

  readonly hoistConstants?: boolean;
  readonly specializeContext?: boolean;
  readonly treeshakeRuntime?: boolean;
  readonly routeCache?: boolean;

  /**
   * Skip the full build when inputs are unchanged (content-hash cache).
   * Persists a `.ignex-cache.json` fingerprint inside `outDir`.
   */
  readonly incremental?: boolean;

  readonly maxInlineBytes?: number;
  /**
   * Opt-in global budget (bytes) for ALL inlined handler bodies. When set,
   * routes are inlined hottest-first until the budget is exhausted; the rest
   * are imported instead. Unset (default) = every eligible route is inlined.
   */
  readonly maxTotalInlineBytes?: number;
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
    treeshakeRuntime: false,
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
    treeshakeRuntime: false,
    routeCache: false,
  },
  2: {
    optimizationLevel: 2,
    inlineThreshold: 50,
    enableHandlerDeduplication: true,
    precompileValidators: false,
    precompileSerializers: false,
    hoistConstants: true,
    specializeContext: true,
    treeshakeRuntime: true,
    routeCache: true,
  },
  3: {
    optimizationLevel: 3,
    inlineThreshold: 50,
    enableHandlerDeduplication: true,
    precompileValidators: true,
    precompileSerializers: true,
    hoistConstants: true,
    specializeContext: true,
    treeshakeRuntime: true,
    routeCache: true,
    incremental: true,
  },
};

/** Per-route `cache-control` configuration (from a route's `config` export). */
export interface RouteCacheConfig {
  readonly maxAge?: number;
  readonly swr?: number;
  readonly immutable?: boolean;
  readonly vary?: readonly string[];
}

/** Build the fully-defaulted {@link CompilerOptions} (env-aware). */
export const createDefaultOptions = (): CompilerOptions => ({
  routesDir: process.env.ROUTES_DIR || "./src/routes",
  appConfig: process.env.APP_CONFIG || "./src/app.config.ts",
  maxRequestBodySize: 128 * 1024 * 1024,
  strictRouteConflicts: false,
  validateCookies: true,
  outDir: process.env.OUT_DIR || "./.ignex",
  outFile: process.env.OUT_FILE || "server.js",
  target: "bun",

  optimizationLevel: 3,
  inlineThreshold: 50,
  enableHandlerDeduplication: true,
  sourceMap: false,
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

  hoistConstants: true,
  specializeContext: true,
  treeshakeRuntime: true,
  routeCache: true,
  incremental: true,

  maxInlineBytes: 2048,
});

/** The default {@link CompilerOptions} (see {@link createDefaultOptions}). */
export const DEFAULT_OPTS: CompilerOptions = createDefaultOptions();

/** A 1-based line / 0-based column source position (ESTree convention). */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/** The kind of a top-level module symbol. */
export type SymbolKind = "function" | "class" | "const" | "let" | "var" | "type" | "interface";

/** Static analysis of a top-level module symbol (for inlining decisions). */
export interface SymbolInfo {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly pos: Position;
  readonly isAsync: boolean;
  readonly isDefaultExport: boolean;
  readonly params: readonly string[];
  readonly returnType?: string;
  readonly decorators: readonly string[];
  readonly calls: readonly string[];
  readonly calledBy: readonly string[];
  readonly size: number;
  readonly hotness: number;
}

/** An import statement parsed from a module. */
export interface ImportInfo {
  readonly source: string;
  readonly names: readonly string[];
  readonly defaultName?: string;
  readonly namespaceName?: string;
}

/** An export statement parsed from a module. */
export interface ExportInfo {
  readonly name: string;
  readonly kind: "default" | "named" | "namespace";
  readonly symbolRef?: string;
}

/**
 * @deprecated Use {@link SourceFile} (source frontend). Kept as a type alias
 * for back-compat while phases migrate to the standard source layer.
 */
export type ModuleInfo = SourceFile;

/** The serialization kind of a route's response. */
export type ResponseType = "json" | "text" | "html" | "stream" | "unknown";

/** Generated standalone validator identifiers per schema part. */
export interface RouteValidators {
  readonly body?: string;
  readonly query?: string;
  readonly params?: string;
  readonly headers?: string;
  readonly cookie?: string;
}

/** Generated serializer identifiers per response shape. */
export interface RouteSerializers {
  readonly json?: string;
  readonly byStatus?: Record<string, string>;
}

/** A hook module reference resolved during analysis. */
export interface HookDef {
  readonly name: string;
  readonly source: string;
  readonly moduleIdx: number;
  readonly isAsync: boolean;
}

/** The output of the discovery phase. */
export interface DiscoveryResult {
  readonly files: readonly string[];
  readonly modules: readonly ModuleInfo[];
  /** Source manager owning every read + parsed source file for this build. */
  readonly sources: SourceManager;
}

/** The output of the analysis phase. */
export interface AnalysisResult {
  readonly routes: readonly RouteIR[];
  readonly modules: readonly ModuleInfo[];
  readonly hooks: ReadonlyMap<string, HookDef>;
  readonly appConfig?: AppConfigInfo;
}

/** Counters describing what the optimization phase changed. */
export interface OptimizationMeta {
  readonly inlined: number;
  readonly deduplicated: number;
  readonly eliminated: number;
}

/** The output of the optimization phase. */
export interface OptimizationResult {
  readonly routes: readonly RouteIR[];
  readonly meta: OptimizationMeta;
}

/** Build metadata attached to a {@link CompileResult}. */
export interface CompilationMeta {
  readonly inlinedHandlers: number;
  readonly deduplicatedHandlers: number;
  readonly eliminatedRoutes: number;
  readonly totalCompileTime: number;
}

/**
 * Structured compiler result — the generated entry source, the diagnostics
 * collected across all phases, and build metadata.
 */
export interface CompileResult {
  /** Generated server entry source code. */
  readonly code: string;
  /** Absolute path of the written server entry on disk. */
  readonly outFile: string;
  /** Every diagnostic (info, warning, and error) collected during the build. */
  readonly diagnostics: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
  readonly errors: readonly Diagnostic[];
  readonly metadata: CompilationMeta;
  /** True when the build was skipped because inputs were unchanged. */
  readonly cached?: boolean;
  /**
   * Relative paths of route files whose content changed since the last build
   * (present only on incremental builds that could not be skipped entirely).
   */
  readonly changedRoutes?: string[];
}

/** Shared per-compile context passed through every phase. */
export interface CompilerContext {
  readonly logger: Logger;
  readonly diagnostics: DiagnosticCollector;
}

/** @deprecated Use {@link CompileResult}. Kept as an alias for back-compat. */
export type CompiledRoute = CompileResult;
