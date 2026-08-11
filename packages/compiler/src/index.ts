/**
 * Flux Compiler Orchestrator — Bun 1.4 edition.
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
 * featured entry point. The sync path (`build` / `compile`) is deprecated:
 * it cannot precompile validators/serializers, minify, or emit source maps.
 */

import { pipe, pipeAsync } from "@flux/shared";
import { storeCache, tryCachedBuild } from "./cache";
import { DiagnosticCodes, DiagnosticCollector, reportDiagnostics } from "./diagnostics";
import type { Logger } from "./logger";
import { consoleLogger } from "./logger";
import { runAnalysis } from "./phases/analysis";
import { writeArtifacts } from "./phases/artifacts";
import { runCodeGen } from "./phases/codegen";
import { runDiscovery } from "./phases/discovery";
import { runLinker, runLinkerAsync } from "./phases/linker";
import { runOptimization } from "./phases/optimization";
import { precompileSerializers } from "./phases/serializers";
import { precompileValidators } from "./phases/validators";
import type { CompileResult, CompilerContext, CompilerOptions, RouteDef } from "./types";
import { DEFAULT_OPTS, type OptimizationMeta } from "./types";
import { mergeOptions, validateOptions } from "./validate";

export {
  type Diagnostic,
  DiagnosticCodes,
  formatDiagnostic,
  getCodeFrame,
} from "./diagnostics";
export type { CompileResult, CompilerOptions };
export { DEFAULT_OPTS, mergeOptions };

/** Build a fresh per-compile context (logger + diagnostic collector). */
const createContext = (logger: Logger): CompilerContext => ({
  logger,
  diagnostics: new DiagnosticCollector(),
});

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
 * The sync path composes the same stages with `pipe`; the async path (the
 * canonical entry) uses `pipeAsync` and adds the precompile + cache stages.
 */
interface PipelineState {
  opts: CompilerOptions;
  ctx: CompilerContext;
  t0: number;
  discovery?: ReturnType<typeof runDiscovery>;
  analysis?: ReturnType<typeof runAnalysis>;
  optimized?: ReturnType<typeof runOptimization>;
  routes: readonly RouteDef[];
  code?: string;
  outPath?: string;
  meta?: OptimizationMeta;
}

const discoveryStage = (s: PipelineState): PipelineState => ({
  ...s,
  discovery: runDiscoveryPhase(s.opts, s.ctx),
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

const linkStageSync = (s: PipelineState): PipelineState => ({
  ...s,
  outPath: runLinkingPhase(s.code as string, s.opts, s.ctx),
});

const cacheStage = async (s: PipelineState): Promise<PipelineState> => {
  if (s.opts.incremental && s.outPath) {
    await storeCache(
      s.opts,
      s.ctx,
      s.outPath,
      (s.optimized as ReturnType<typeof runOptimization>).meta,
    );
  }
  return s;
};

export const runDiscoveryPhase = (
  opts: CompilerOptions,
  ctx: CompilerContext,
): ReturnType<typeof runDiscovery> =>
  ctx.logger.time("discovery", () => {
    const result = runDiscovery(opts, ctx);

    ctx.logger.info("discovery complete", {
      files: result.files.length,
      modules: result.modules.length,
    });

    return result;
  });

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

export const runCodegenPhase = (
  optimized: ReturnType<typeof runOptimization>,
  analysis: ReturnType<typeof runAnalysis>,
  opts: CompilerOptions,
  ctx: CompilerContext,
): string =>
  ctx.logger.time("codegen", () => {
    const code = runCodeGen(optimized.routes, analysis.modules, analysis.hooks, opts, ctx);

    ctx.logger.info("codegen complete", {
      lines: code.split("\n").length,
    });

    return code;
  });

export const runLinkingPhase = (
  code: string,
  opts: CompilerOptions,
  ctx: CompilerContext,
): string => runLinker(code, opts, ctx);

export const runLinkingPhaseAsync = (
  code: string,
  opts: CompilerOptions,
  ctx: CompilerContext,
): Promise<string> => runLinkerAsync(code, opts, ctx);

const finish = (
  code: string,
  outPath: string,
  ctx: CompilerContext,
  elapsed: number,
  cached = false,
  meta?: OptimizationMeta,
): CompileResult => {
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
  };
};

export class FluxCompiler {
  constructor(private readonly input: Partial<CompilerOptions> = {}) {}

  /**
   * Synchronous compile.
   *
   * @deprecated The sync path cannot precompile validators/serializers,
   * minify, or emit source maps. Prefer {@link compileAsync}.
   */
  compile(): CompileResult {
    const validated = validateOptions(this.input);

    if (!validated.ok) {
      throw new Error(`Compiler options invalid:\n${validated.error.join("\n")}`);
    }

    const opts = validated.value;
    const ctx = createContext(consoleLogger());
    const t0 = performance.now();

    if (opts.precompileValidators || opts.precompileSerializers) {
      ctx.diagnostics.info({
        code: DiagnosticCodes.SyncLimited,
        message:
          "compile() is synchronous. Use buildAsync() to enable validator/serializer precompilation, minification, and source maps.",
      });
    }

    ctx.logger.info("flux compiler started (sync)", {
      target: opts.target,
      optimizationLevel: opts.optimizationLevel,
      routesDir: opts.routesDir,
      outDir: opts.outDir,
    });

    const state = pipe({ opts, ctx, t0, routes: [] } as PipelineState)(
      discoveryStage,
      analysisStage,
      optimizationStage,
      artifactsStage,
      codegenStage,
      linkStageSync,
    ) as PipelineState;

    const elapsed = performance.now() - t0;

    return finish(state.code as string, state.outPath as string, ctx, elapsed, false, state.meta);
  }

  /** Canonical async compile with validator/serializer precompilation. */
  async compileAsync(): Promise<CompileResult> {
    const validated = validateOptions(this.input);

    if (!validated.ok) {
      throw new Error(`Compiler options invalid:\n${validated.error.join("\n")}`);
    }

    const opts = validated.value;
    const ctx = createContext(consoleLogger());
    const t0 = performance.now();

    ctx.logger.info("flux compiler started (async)", {
      target: opts.target,
      optimizationLevel: opts.optimizationLevel,
      routesDir: opts.routesDir,
      outDir: opts.outDir,
    });

    // Incremental fast path: reuse the previous build when nothing changed.
    if (opts.incremental) {
      const cached = await tryCachedBuild(opts, ctx);
      if (cached) {
        // Artifacts (openapi.json, client.ts/d.ts, routes.d.ts) are NOT stored
        // in the cache, so on a cache hit they could go stale or go missing.
        // Regenerate them from a fresh discovery/analysis (skipping the
        // expensive codegen + link steps) whenever artifact generation is on.
        if (opts.generateTypes || opts.generateOpenAPI || opts.generateClient) {
          await pipeAsync({ opts, ctx, t0, routes: [] } as PipelineState)(
            discoveryStage,
            analysisStage,
            optimizationStage,
            artifactsStage,
          );
        }
        const elapsed = performance.now() - t0;
        return finish(cached.code, cached.outFile, ctx, elapsed, true, cached.meta);
      }
    }

    const state = (await pipeAsync({ opts, ctx, t0, routes: [] } as PipelineState)(
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

      throw new Error(
        `Compilation failed with ${ctx.diagnostics.errors.length} error(s):\n${summary}`,
      );
    }

    return finish(state.code as string, state.outPath as string, ctx, elapsed, false, state.meta);
  }
}

export function build(opts?: Partial<CompilerOptions>): CompileResult {
  return new FluxCompiler(opts).compile();
}

export async function buildAsync(opts?: Partial<CompilerOptions>): Promise<CompileResult> {
  return new FluxCompiler(opts).compileAsync();
}

if (import.meta.main) {
  await buildAsync();
}
