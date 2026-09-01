/**
 * @fileoverview Composed build pipeline — the pure stage functions threaded
 * through {@link IgnexCompiler.compileAsync}.
 *
 * Each stage is a pure function over a {@link PipelineState} (returning a new
 * state), so the whole build reads as a declarative pipeline:
 *
 *   validate → discover → analyze → optimize → (precompile validators/
 *   serializers) → artifacts → codegen → link → cache
 *
 * Extracted from `src/index.ts` so the orchestrator stays a thin composition
 * of named stages and the stage wiring is independently reviewable.
 */

import { storeCache } from "./cache";
import { DiagnosticCodes, errorMessage, reportDiagnostics } from "./diagnostics";
import type { SourceManager } from "./frontend";
import { persistModules } from "./frontend/persist";
import { runAnalysis } from "./phases/analysis";
import { writeArtifacts } from "./phases/artifacts";
import { runCodeGen } from "./phases/codegen";
import { runDiscovery } from "./phases/discovery";
import { runLinkerAsync } from "./phases/linker";
import { runOptimization } from "./phases/optimization";
import { precompileSerializers } from "./phases/serializers";
import { precompileValidators } from "./phases/validators";
import type {
  CompileResult,
  CompilerContext,
  CompilerOptions,
  OptimizationMeta,
  RouteIR,
} from "./types";

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
export interface PipelineState {
  opts: CompilerOptions;
  ctx: CompilerContext;
  t0: number;
  /**
   * Whole-build content fingerprint, computed once per incremental build by
   * the orchestrator (`computeFingerprint`) and shared between the cache-hit
   * probe ({@link tryCachedBuild}) and the post-build store
   * ({@link storeCache}) — hashing every file under core/src + routesDir is
   * the most expensive cold-path work in an incremental rebuild.
   */
  fingerprint?: string;
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

export const discoveryStage = (s: PipelineState): PipelineState => ({
  ...s,
  discovery: runDiscoveryPhase(s.opts, s.ctx, s.sources),
});

export const analysisStage = (s: PipelineState): PipelineState => ({
  ...s,
  analysis: runAnalysisPhase(s.discovery as ReturnType<typeof runDiscovery>, s.opts, s.ctx),
});

export const optimizationStage = (s: PipelineState): PipelineState => {
  const optimized = runOptimizationPhase(
    s.analysis as ReturnType<typeof runAnalysis>,
    s.opts,
    s.ctx,
  );
  return { ...s, optimized, routes: optimized.routes, meta: optimized.meta };
};

export const precompileStage = async (s: PipelineState): Promise<PipelineState> => {
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

export const artifactsStage = (s: PipelineState): PipelineState => {
  writeArtifacts(s.routes, (s.analysis as ReturnType<typeof runAnalysis>).modules, s.opts, s.ctx);
  return s;
};

export const codegenStage = (s: PipelineState): PipelineState => ({
  ...s,
  code: runCodegenPhase(
    s.optimized as ReturnType<typeof runOptimization>,
    s.analysis as ReturnType<typeof runAnalysis>,
    s.opts,
    s.ctx,
  ),
});

export const linkStage = async (s: PipelineState): Promise<PipelineState> => ({
  ...s,
  outPath: await runLinkingPhaseAsync(s.code as string, s.opts, s.ctx),
});

export const cacheStage = async (s: PipelineState): Promise<PipelineState> => {
  // Never cache a failed build — analysis/linker errors surface via the final
  // `hasErrors` check; caching them would poison the next incremental build.
  if (s.opts.incremental && s.outPath && !s.ctx.diagnostics.hasErrors) {
    await storeCache(
      s.opts,
      s.ctx,
      s.outPath,
      (s.optimized as ReturnType<typeof runOptimization>).meta,
      // Shared fingerprint (avoids a second full-tree hash) + the discovery
      // file list (avoids a second routesDir walk) when available.
      s.fingerprint,
      s.discovery?.files,
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
 * module, and build the source manager (internal pipeline stage).
 */
const runDiscoveryPhase = (
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
 * hooks/app config from the discovery output (internal pipeline stage).
 */
const runAnalysisPhase = (
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
 * code, and eliminate constant routes (internal pipeline stage).
 */
const runOptimizationPhase = (
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
 * routes (internal pipeline stage).
 */
const runCodegenPhase = (
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

/** Bundle/minify the emitted server via `Bun.build` (internal pipeline stage). */
const runLinkingPhaseAsync = (
  code: string,
  opts: CompilerOptions,
  ctx: CompilerContext,
): Promise<string> => runLinkerAsync(code, opts, ctx);

/** Finalize a build: log, report diagnostics, and shape the `CompileResult`. */
export const finish = (opts: {
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
