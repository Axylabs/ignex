/**
 * Ignex Compiler Type System
 *
 * AOT upgrade:
 * - unified ContextUsage from shared
 * - added advanced compiler options
 * - added route metadata for future validators/serializers/OpenAPI
 */

import type { HttpMethod } from "@ignex/shared";
import type { Diagnostic, DiagnosticCollector } from "./diagnostics";
import type { SourceFile } from "./frontend/source-file";
import type { SourceManager } from "./frontend/source-manager";
import type { RouteIR } from "./ir/route";
import type { Logger } from "./logger";
import type { OptimizationLevel } from "./options";

// Re-export the canonical IR route type.
export type { RouteIR } from "./ir/route";
export type { Diagnostic, Logger };
/** Info about the discovered app config module (`src/app.config.ts`). */
export interface AppConfigInfo {
  readonly path: string;
  readonly relPath: string;
  readonly hasPlugins: boolean;
  readonly hasLifecycle: boolean;
  readonly hasServer: boolean;
  /**
   * True when the `plugins` export still contributes per-request lifecycle
   * hooks after dev-only plugins that are provably disabled for this build
   * (e.g. `debugbar()` in a production build) have been eliminated. Used for
   * AOT optimization decisions (`needsFull`, constant hoisting) — the runtime
   * lifecycle is cleaned separately by codegen.
   */
  readonly hasActivePlugins: boolean;
  /**
   * True when a `debugbar()` element is registered and NOT provably disabled
   * for this build. Codegen bakes this into a `__TRACE_DEBUG` module constant
   * so the lifecycle-stage instrumentation (`runTimed` / `debugStageEnd`) is
   * const-folded out of production artifacts — a disabled/absent debugbar
   * costs zero closures per request. Conservatively false for aliased
   * imports (the plugin still runs; only the automatic stage rows are off).
   */
  readonly hasEnabledDebugbar: boolean;
  /**
   * True when this build is production-shaped (`--compile`, or
   * `NODE_ENV=production` at build time, without `IGNEX_DEBUG=1`). Codegen
   * bakes it as `globalThis.__IGNEX_PROD_BUILD = true` so dev-only plugins
   * (debugbar) stay inert even when the artifact is launched without
   * `NODE_ENV=production` in the runtime environment.
   */
  readonly isProductionBuild: boolean;
}

/**
 * Per-route RBAC guards, from `withGuards(handler, guards)` (mirrors
 * `@ignex/core`'s `RouteGuards`). Emitted into the route's pre-execution hook
 * chain by codegen.
 */
export interface RouteGuards {
  roles?: string[];
  permissions?: string[];
  /** Require ALL listed permissions instead of any. */
  all?: boolean;
  /** Require an authenticated user only (default when no roles/permissions). */
  authenticated?: boolean;
  /**
   * A guards argument was present but could not be statically evaluated
   * (e.g. `PERMS.X` imported constants). The static chain is INCOMPLETE —
   * codegen must preserve the runtime wrapper (never drop it via inlining),
   * otherwise authorization would silently degrade to authenticated-only.
   */
  opaque?: true;
}

export type { HttpMethod };

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

  /**
   * Emit a standalone Bun executable (`Bun.build` `compile`) instead of a JS
   * bundle. The binary embeds the Bun runtime, so it can be deployed without
   * installing Bun. Implies `minify` and production defaults (`NODE_ENV`,
   * bytecode, linked sourcemap). Default `false`.
   */
  readonly compile?: boolean;

  /**
   * Output path/name for the compiled executable. Defaults to
   * `join(outDir, serviceName)` (e.g. `.ignex/ignex`). A `.exe` suffix is
   * added automatically on Windows.
   */
  readonly binaryOutfile?: string;

  /**
   * Enable bytecode compilation of the standalone executable (faster startup,
   * slightly slower build). Only meaningful with `compile`. Default `true`.
   */
  readonly bytecode?: boolean;

  /**
   * Declare this a PRODUCTION-shaped build (same effect as `compile: true` or
   * `NODE_ENV=production` at build time, without shipping a binary). Unless
   * `IGNEX_DEBUG=1` opts back in, a production shape
   *
   * - eliminates every reachable `debugbar()` (dev-only plugin elimination:
   *   the toolbar, observatory stack and per-request tracing instrumentation
   *   are treeshaken out of the artifact),
   * - restores every AOT optimization the debugbar would have disabled
   *   (constant hoisting, usage-specialized contexts),
   * - bakes `globalThis.__IGNEX_PROD_BUILD = true` so the runtime debugbar
   *   guard stays locked even when launched without `NODE_ENV=production`,
   * - bakes the TLS policy (`production: true` in `resolveServeTls` — never
   *   auto-generates dev certificates) and disables the dev build-error
   *   overlay marker probe,
   * - defaults `exposeErrorDetails` to `false` (safe error responses unless
   *   explicitly opted in).
   *
   * `ignex build` sets this by default; pass `--dev` for a dev-shaped
   * artifact. Part of the cache fingerprint.
   */
  readonly production?: boolean;

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
  readonly routeCache?: boolean;

  /**
   * Emit a per-route pre-baked native stack (`createNativeRoute`) for
   * full-context routes that parse/validate query/cookies or validate an
   * unread body. The addon (castrum with the route module) parses them in ONE
   * C-ABI call; when the addon lacks the route surface the compiled core fn
   * falls back to the JS prelude (byte-parity preserved). Default `true`
   * (Phase 4) — a missing/unloaded addon degrades gracefully to the JS
   * prelude at runtime.
   */
  readonly nativeRoutes?: boolean;

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

  /**
   * Dev-only profile-guided optimization capture: emit a per-route request
   * counter into the generated server that periodically flushes
   * `<outDir>/hot-routes.json`. The next build merges the measured frequencies
   * into `hotnessScore` (inline-budget priority, dedup-leader choice). Off by
   * default — `ignex dev` turns it on (opt out with `--no-heat`). Production
   * builds never emit the counter.
   */
  readonly heatCapture?: boolean;
}

/** Per-route `cache-control` configuration (from a route's `config` export). */
export interface RouteCacheConfig {
  readonly maxAge?: number;
  readonly swr?: number;
  readonly immutable?: boolean;
  readonly vary?: readonly string[];
}

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

// Re-export runtime options/presets from `./options` so existing
// `from "../types"` imports keep working unchanged (see options.ts).
export {
  createDefaultOptions,
  DEFAULT_OPTS,
  FULL_CONTEXT_USAGE,
  normalizeHttpMethod,
  type OptimizationLevel,
  optimizationPresets,
  SCHEMA_PARTS,
} from "./options";
