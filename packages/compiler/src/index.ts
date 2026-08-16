/**
 * Ignex Compiler Orchestrator — Bun 1.4 edition.
 *
 * The compiler follows a Svelte-style phased pipeline:
 *
 *   discovery → analysis → optimization → (precompile validators/serializers)
 *       → codegen → linker → artifacts
 *
 * Every phase receives a {@link CompilerContext} carrying a `Logger` sink and a
 * `DiagnosticCollector`, so problems are surfaced as structured diagnostics
 * (code + severity + position + frame) instead of being silently swallowed.
 *
 * The async path (`buildAsync` / `compileAsync`) is the canonical, fully
 * featured entry point. The old sync path (`build` / `compile`) was removed —
 * it could not precompile validators/serializers, minify, or emit source maps.
 */

import { pipeAsync } from "@ignex/shared";
import { computeRouteChanges, storeCache, tryCachedBuild } from "./cache";
import {
  DiagnosticCodes,
  DiagnosticCollector,
  errorMessage,
  reportDiagnostics,
} from "./diagnostics";
import { SourceManager } from "./frontend";
import { loadPersistedModules, persistModules } from "./frontend/persist";
import type { Logger } from "./logger";
import { consoleLogger } from "./logger";
import { runAnalysis } from "./phases/analysis";
import { writeArtifacts } from "./phases/artifacts";
import { runCodeGen } from "./phases/codegen";
import { runDiscovery } from "./phases/discovery";
import { runLinkerAsync } from "./phases/linker";
import { runOptimization } from "./phases/optimization";
import { precompileSerializers } from "./phases/serializers";
import { precompileValidators } from "./phases/validators";
import type { CompileResult, CompilerContext, CompilerOptions, RouteIR } from "./types";
import { DEFAULT_OPTS, type OptimizationMeta } from "./types";
import { mergeOptions, validateOptions } from "./validate";

export {
  computeRouteChanges,
  computeRouteFingerprint,
  diffRouteFingerprints,
  fingerprintRouteFiles,
  type RouteChangeSet,
  type RouteFingerprint,
} from "./cache";
export {
  type Diagnostic,
  DiagnosticCodes,
  formatDiagnostic,
  getCodeFrame,
} from "./diagnostics";
export {
  generateClient,
  generateClientDts,
  generateManifest,
  generateOpenApi,
  generateRouteTypes,
  writeArtifacts,
} from "./phases/artifacts";
// Route/OpenAPI helpers are part of the public surface so consumers (e.g. the
// standalone `scripts/generate-openapi-client.ts`) can share the canonical
// implementations instead of re-implementing (and drifting from) them.
export { parseRouteFilename } from "./phases/discovery";
export type { CompileResult, CompilerOptions, RouteIR } from "./types";
export { DEFAULT_OPTS, mergeOptions };

/** Build a fresh per-compile context (logger + diagnostic collector). */
const createContext = (logger: Logger): CompilerContext => ({
  logger,
  diagnostics: new DiagnosticCollector(),
});

/**
 * Thrown when a compile fails option validation or produces error-level
 * diagnostics. Carries a machine `code` and the compiler `diagnostics` so
 * programmatic callers can branch without string-matching the message.
 */
export class CompilationError extends Error {
  constructor(
    message: string,
    public readonly code: "INVALID_OPTIONS" | "COMPILE_FAILED",
    public readonly diagnostics: readonly import("./diagnostics").Diagnostic[],
  ) {
    super(message);
    this.name = "CompilationError";
  }
}

// ============================================================================
// Composed build pipeline
// ============================================================================

/**
 * Results threaded through the composed build stages. Each stage is a pure
 * function over this state (returning a new state), so the whole build reads
 * as a declarative pipeline:
 *
 *   validate → discover → analyze → optimize → (precompile validators/
 *   serializers) → artifacts → codegen → link → cache
 *
 * Every stage is a pure function composed with `pipeAsync` (the canonical
 * async entry); the precompile + cache stages are async-only.
 */
interface PipelineState {
  opts: CompilerOptions;
  ctx: CompilerContext;
  t0: number;
  discovery?: ReturnType<typeof runDiscovery>;
  analysis?: ReturnType<typeof runAnalysis>;
  optimized?: ReturnType<typeof runOptimization>;
  /** Source manager seeded with the persistent parse cache, if any. */
  sources?: SourceManager;
  routes: readonly RouteIR[];
  code?: string;
  outPath?: string;
  meta?: OptimizationMeta;
}

const discoveryStage = (s: PipelineState): PipelineState => ({
  ...s,
  discovery: runDiscoveryPhase(s.opts, s.ctx, s.sources),
});

const analysisStage = (s: PipelineState): PipelineState => ({
  ...s,
  analysis: runAnalysisPhase(s.discovery as ReturnType<typeof runDiscovery>, s.opts, s.ctx),
});

const optimizationStage = (s: PipelineState): PipelineState => {
  const optimized = runOptimizationPhase(
    s.analysis as ReturnType<typeof runAnalysis>,
    s.opts,
    s.ctx,
  );
  return { ...s, optimized, routes: optimized.routes, meta: optimized.meta };
};

const precompileStage = async (s: PipelineState): Promise<PipelineState> => {
  const analysis = s.analysis as ReturnType<typeof runAnalysis>;
  let routes = s.routes;
  routes = await precompileValidators(routes, analysis.modules, s.opts, s.ctx);
  routes = await precompileSerializers(routes, analysis.modules, s.opts, s.ctx);
  // The precompiled routes (validators/serializers/schemaDoc) replace the
  // optimization result's routes so codegen sees the enriched set.
  return {
    ...s,
    optimized: { ...(s.optimized as ReturnType<typeof runOptimization>), routes },
    routes,
  };
};

const artifactsStage = (s: PipelineState): PipelineState => {
  writeArtifacts(s.routes, s.opts, s.ctx);
  return s;
};

const codegenStage = (s: PipelineState): PipelineState => ({
  ...s,
  code: runCodegenPhase(
    s.optimized as ReturnType<typeof runOptimization>,
    s.analysis as ReturnType<typeof runAnalysis>,
    s.opts,
    s.ctx,
  ),
});

const linkStage = async (s: PipelineState): Promise<PipelineState> => ({
  ...s,
  outPath: await runLinkingPhaseAsync(s.code as string, s.opts, s.ctx),
});

const cacheStage = async (s: PipelineState): Promise<PipelineState> => {
  // Never cache a failed build — analysis/linker errors surface via the final
  // `hasErrors` check; caching them would poison the next incremental build.
  if (s.opts.incremental && s.outPath && !s.ctx.diagnostics.hasErrors) {
    await storeCache(
      s.opts,
      s.ctx,
      s.outPath,
      (s.optimized as ReturnType<typeof runOptimization>).meta,
    );

    // Persist per-module parse results so the next build rehydrates instead of
    // re-parsing unchanged modules (see frontend/persist.ts).
    try {
      if (s.discovery?.sources) {
        persistModules(s.discovery.sources.all(), s.opts.outDir);
      }
    } catch (error) {
      s.ctx.diagnostics.warn({
        code: DiagnosticCodes.BuildCacheInvalid,
        message: `Failed to write module parse cache: ${errorMessage(error)}`,
      });
    }
  }
  return s;
};

/**
 * Run the discovery phase: scan the routes directory, parse every route
 * module, and build the source manager. Exposed for callers that compose the
 * pipeline themselves instead of using {@link IgnexCompiler}.
 */
export const runDiscoveryPhase = (
  opts: CompilerOptions,
  ctx: CompilerContext,
  sources?: SourceManager,
): ReturnType<typeof runDiscovery> =>
  ctx.logger.time("discovery", () => {
    const result = runDiscovery(opts, ctx, sources);

    ctx.logger.info("discovery complete", {
      files: result.files.length,
      modules: result.modules.length,
    });

    return result;
  });

/**
 * Run the analysis phase: build the route graph, detect conflicts, and resolve
 * hooks/app config from the discovery output. Exposed for custom pipelines.
 */
export const runAnalysisPhase = (
  discovery: ReturnType<typeof runDiscovery>,
  opts: CompilerOptions,
  ctx: CompilerContext,
): ReturnType<typeof runAnalysis> =>
  ctx.logger.time("analysis", () => {
    const result = runAnalysis(discovery, opts, ctx);

    ctx.logger.info("analysis complete", {
      routes: result.routes.length,
      hooks: result.hooks.size,
    });

    return result;
  });

/**
 * Run the optimization phase: inline eligible handlers, de-duplicate shared
 * code, and eliminate constant routes. Exposed for custom pipelines.
 */
export const runOptimizationPhase = (
  analysis: ReturnType<typeof runAnalysis>,
  opts: CompilerOptions,
  ctx: CompilerContext,
): ReturnType<typeof runOptimization> =>
  ctx.logger.time("optimization", () => {
    const result = runOptimization(analysis.routes, analysis.modules, opts, ctx);

    ctx.logger.info("optimization complete", {
      inlined: result.meta.inlined,
      deduplicated: result.meta.deduplicated,
      eliminated: result.meta.eliminated,
    });

    return result;
  });

/**
 * Run the codegen phase: emit the server module string from the optimized
 * routes. Exposed for custom pipelines.
 */
export const runCodegenPhase = (
  optimized: ReturnType<typeof runOptimization>,
  analysis: ReturnType<typeof runAnalysis>,
  opts: CompilerOptions,
  ctx: CompilerContext,
): string =>
  ctx.logger.time("codegen", () => {
    const code = runCodeGen(
      optimized.routes,
      analysis.modules,
      analysis.hooks,
      opts,
      ctx,
      analysis.appConfig,
    );

    ctx.logger.info("codegen complete", {
      lines: code.split("\n").length,
    });

    return code;
  });

/** Bundle/minify the emitted server via `Bun.build`. */
export const runLinkingPhaseAsync = (
  code: string,
  opts: CompilerOptions,
  ctx: CompilerContext,
): Promise<string> => runLinkerAsync(code, opts, ctx);

const finish = (opts: {
  code: string;
  outPath: string;
  ctx: CompilerContext;
  elapsed: number;
  cached?: boolean | undefined;
  meta?: OptimizationMeta | undefined;
  changedRoutes?: string[] | undefined;
}): CompileResult => {
  const { code, outPath, ctx, elapsed, cached = false, meta, changedRoutes } = opts;
  ctx.logger.info("build complete", {
    elapsedMs: Number(elapsed.toFixed(2)),
    outPath,
    ...(cached ? { cached: true } : {}),
  });

  reportDiagnostics(ctx.diagnostics.all, ctx.logger);

  const metadata = {
    inlinedHandlers: meta?.inlined ?? 0,
    deduplicatedHandlers: meta?.deduplicated ?? 0,
    eliminatedRoutes: meta?.eliminated ?? 0,
    totalCompileTime: Number(elapsed.toFixed(2)),
  };

  return {
    code,
    outFile: outPath,
    diagnostics: ctx.diagnostics.all,
    warnings: ctx.diagnostics.warnings,
    errors: ctx.diagnostics.errors,
    metadata,
    ...(cached ? { cached } : {}),
    ...(changedRoutes ? { changedRoutes } : {}),
  };
};

/**
 * Per-compile orchestrator.
 *
 * Threads a `CompilerContext` (logger + diagnostics) through the full phase
 * pipeline — discovery → analysis → optimization → precompile → artifacts →
 * codegen → link → cache. The canonical entry point is {@link compileAsync}.
 *
 * @param input - Partial {@link CompilerOptions}; validated + defaulted on
 * each compile via `validateOptions`.
 */
export class IgnexCompiler {
  constructor(private readonly input: Partial<CompilerOptions> = {}) {}

  /** Canonical async compile with validator/serializer precompilation. */
  async compileAsync(): Promise<CompileResult> {
    const ctx = createContext(consoleLogger(this.input.verbose ?? false));
    const validated = validateOptions(this.input, ctx.diagnostics);

    if (!validated.ok) {
      // Surface deprecation/unknown-option diagnostics even when validation
      // fails, so option drift is visible instead of a bare throw.
      reportDiagnostics(ctx.diagnostics.all, ctx.logger);
      throw new CompilationError(
        `Compiler options invalid:\n${validated.error.join("\n")}`,
        "INVALID_OPTIONS",
        ctx.diagnostics.all,
      );
    }

    const opts = validated.value;
    const t0 = performance.now();

    // Seed discovery with the persistent parse cache so unchanged modules skip
    // re-parsing on both cache-hit artifact regeneration and full rebuilds.
    const diskCache = opts.incremental ? loadPersistedModules(opts.outDir) : new Map();
    const sources = new SourceManager(diskCache);

    ctx.logger.info("ignex compiler started (async)", {
      target: opts.target,
      optimizationLevel: opts.optimizationLevel,
      routesDir: opts.routesDir,
      outDir: opts.outDir,
    });

    // Incremental fast path: reuse the previous build when nothing changed.
    let routeChanges: ReturnType<typeof computeRouteChanges>;
    if (opts.incremental) {
      const cached = await tryCachedBuild(opts, ctx);
      if (cached) {
        // Artifacts (openapi.json, client.ts/d.ts, routes.d.ts) are NOT stored
        // in the cache, so on a cache hit they could go stale or go missing.
        // Regenerate them from a fresh discovery/analysis (skipping the
        // expensive codegen + link steps) whenever artifact generation is on.
        if (opts.generateTypes || opts.generateOpenAPI || opts.generateClient) {
          const state = (await pipeAsync({ opts, ctx, t0, routes: [], sources } as PipelineState)(
            discoveryStage,
            analysisStage,
            optimizationStage,
            artifactsStage,
          )) as PipelineState;

          // Self-heal the module parse cache on cache hits too — a cache hit
          // re-parses when the file is missing, so persist the result.
          try {
            if (state.discovery?.sources) {
              persistModules(state.discovery.sources.all(), opts.outDir);
            }
          } catch (error) {
            ctx.diagnostics.warn({
              code: DiagnosticCodes.BuildCacheInvalid,
              message: `Failed to write module parse cache: ${errorMessage(error)}`,
            });
          }
        }
        const elapsed = performance.now() - t0;
        return finish({
          code: cached.code,
          outPath: cached.outFile,
          ctx,
          elapsed,
          cached: true,
          meta: cached.meta,
        });
      }

      // Whole-build cache miss: report exactly which route files changed since
      // the last build. This is the parse-level incrementality foundation — a
      // later increment re-emits only these routes instead of the whole build.
      routeChanges = computeRouteChanges(opts);
      if (routeChanges && routeChanges.changed.length > 0) {
        ctx.logger.info(
          `Incremental build — ${routeChanges.changed.length} route(s) changed: ${routeChanges.changed.join(", ")}`,
        );
      }
    } else {
      // Non-incremental full build: compute the change set once for metadata.
      routeChanges = computeRouteChanges(opts);
    }

    const state = (await pipeAsync({ opts, ctx, t0, routes: [], sources } as PipelineState)(
      discoveryStage,
      analysisStage,
      optimizationStage,
      precompileStage,
      artifactsStage,
      codegenStage,
      linkStage,
      cacheStage,
    )) as PipelineState;

    const elapsed = performance.now() - t0;

    if (ctx.diagnostics.hasErrors) {
      const summary = ctx.diagnostics.errors.map((d) => `  - ${d.code}: ${d.message}`).join("\n");

      throw new CompilationError(
        `Compilation failed with ${ctx.diagnostics.errors.length} error(s):\n${summary}`,
        "COMPILE_FAILED",
        ctx.diagnostics.all,
      );
    }

    return finish({
      code: state.code as string,
      outPath: state.outPath as string,
      ctx,
      elapsed,
      meta: state.meta,
      changedRoutes: routeChanges?.changed,
    });
  }
}

/**
 * Top-level convenience: compile once and return the {@link CompileResult}.
 *
 * Equivalent to `new IgnexCompiler(opts).compileAsync()`. Throws an `Error`
 * with a summary of validation/compile diagnostics on failure.
 *
 * @param opts - Partial {@link CompilerOptions}.
 * @returns The structured compile result.
 */
export async function buildAsync(opts?: Partial<CompilerOptions>): Promise<CompileResult> {
  return new IgnexCompiler(opts).compileAsync();
}

if (import.meta.main) {
  await buildAsync();
}
