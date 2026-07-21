/**
 * Flux Compiler Orchestrator — Bun 1.4 edition.
 *
 * Async build uses Bun.build linker.
 */

import type {
  CompilerOptions,
  CompiledRoute,
  DiscoveryResult,
  AnalysisResult,
  OptimizationResult,
} from "./types";

import type { Logger } from "./logger";
import { DEFAULT_OPTS } from "./types";
import { runDiscovery } from "./phases/discovery";
import { runAnalysis } from "./phases/analysis";
import { runOptimization } from "./phases/optimization";
import { runCodeGen } from "./phases/codegen";
import { runLinker, runLinkerAsync } from "./phases/linker";
import { writeArtifacts } from "./phases/artifacts";
import { precompileValidators } from "./phases/validators";
import { precompileSerializers } from "./phases/serializers";
import { consoleLogger } from "./logger";
import { validateOptions } from "./validate";
import { defu } from "defu";

export { DEFAULT_OPTS };
export type { CompilerOptions, CompiledRoute };

export const mergeOptions = (
  opts: Partial<CompilerOptions>
): CompilerOptions => defu(opts, DEFAULT_OPTS) as CompilerOptions;

export const createCompilationResult = (
  optimized: OptimizationResult,
  analysis: AnalysisResult,
  elapsedMs: number
): CompiledRoute => ({
  staticRoutes: optimized.routes.filter((r) => r.isStatic),
  dynamicRoutes: optimized.routes.filter((r) => r.isDynamic),
  modules: analysis.modules,
  meta: {
    inlinedHandlers: optimized.meta.inlined,
    deduplicatedHandlers: optimized.meta.deduplicated,
    eliminatedRoutes: optimized.meta.eliminated,
    totalCompileTime: elapsedMs,
  },
});

export const runDiscoveryPhase = (
  opts: CompilerOptions,
  logger: Logger
): DiscoveryResult =>
  logger.time("discovery", () => {
    const result = runDiscovery(opts, logger);

    logger.info("discovery complete", {
      files: result.files.length,
      modules: result.modules.length,
    });

    return result;
  });

export const runAnalysisPhase = (
  discovery: DiscoveryResult,
  opts: CompilerOptions,
  logger: Logger
): AnalysisResult =>
  logger.time("analysis", () => {
    const result = runAnalysis(discovery, opts, logger);

    logger.info("analysis complete", {
      routes: result.routes.length,
      hooks: result.hooks.size,
    });

    return result;
  });

export const runOptimizationPhase = (
  analysis: AnalysisResult,
  opts: CompilerOptions,
  logger: Logger
): OptimizationResult =>
  logger.time("optimization", () => {
    const result = runOptimization(
      analysis.routes,
      analysis.modules,
      opts,
      logger
    );

    logger.info("optimization complete", {
      inlined: result.meta.inlined,
      deduplicated: result.meta.deduplicated,
      eliminated: result.meta.eliminated,
    });

    return result;
  });

export const runCodegenPhase = (
  optimized: OptimizationResult,
  analysis: AnalysisResult,
  opts: CompilerOptions,
  logger: Logger
): string =>
  logger.time("codegen", () => {
    const code = runCodeGen(
      optimized.routes,
      analysis.modules,
      analysis.hooks,
      opts,
      logger
    );

    logger.info("codegen complete", {
      lines: code.split("\n").length,
    });

    return code;
  });

export const runLinkingPhase = (
  code: string,
  opts: CompilerOptions,
  logger: Logger
): string =>
  logger.time("linker", () => {
    return runLinker(code, opts, logger);
  });

export const runLinkingPhaseAsync = async (
  code: string,
  opts: CompilerOptions,
  logger: Logger
): Promise<string> => {
  return runLinkerAsync(code, opts, logger);
};

export class FluxCompiler {
  constructor(private readonly input: Partial<CompilerOptions> = {}) {}

  compile(): CompiledRoute {
    const validated = validateOptions(this.input);

    if (!validated.ok) {
      throw new Error(
        `Compiler options invalid:\n${validated.error.join("\n")}`
      );
    }

    const opts = validated.value;
    const logger = consoleLogger();
    const t0 = performance.now();

    if (opts.precompileValidators || opts.precompileSerializers) {
      logger.warn(
        "compile() is synchronous. Use buildAsync() to enable validator/serializer precompilation."
      );
    }

    logger.info("flux compiler started", {
      target: opts.target,
      optimizationLevel: opts.optimizationLevel,
      routesDir: opts.routesDir,
      outDir: opts.outDir,
    });

    const discovery = runDiscoveryPhase(opts, logger);
    const analysis = runAnalysisPhase(discovery, opts, logger);
    const optimized = runOptimizationPhase(analysis, opts, logger);

    writeArtifacts(optimized.routes, opts, logger);

    const code = runCodegenPhase(optimized, analysis, opts, logger);
    const outPath = runLinkingPhase(code, opts, logger);

    const elapsed = performance.now() - t0;

    logger.info("build complete", {
      elapsedMs: Number(elapsed.toFixed(2)),
      outPath,
    });

    return createCompilationResult(optimized, analysis, elapsed);
  }

  async compileAsync(): Promise<CompiledRoute> {
    const validated = validateOptions(this.input);

    if (!validated.ok) {
      throw new Error(
        `Compiler options invalid:\n${validated.error.join("\n")}`
      );
    }

    const opts = validated.value;
    const logger = consoleLogger();
    const t0 = performance.now();

    logger.info("flux compiler started (async)", {
      target: opts.target,
      optimizationLevel: opts.optimizationLevel,
      routesDir: opts.routesDir,
      outDir: opts.outDir,
    });

    const discovery = runDiscoveryPhase(opts, logger);
    const analysis = runAnalysisPhase(discovery, opts, logger);
    const optimized = runOptimizationPhase(analysis, opts, logger);

    let routes = optimized.routes;

    routes = await precompileValidators(
      routes,
      analysis.modules,
      opts,
      logger
    );

    routes = await precompileSerializers(
      routes,
      analysis.modules,
      opts,
      logger
    );

    const enriched: OptimizationResult = {
      routes,
      meta: optimized.meta,
    };

    writeArtifacts(enriched.routes, opts, logger);

    const code = runCodegenPhase(enriched, analysis, opts, logger);
    const outPath = await runLinkingPhaseAsync(code, opts, logger);

    const elapsed = performance.now() - t0;

    logger.info("build complete", {
      elapsedMs: Number(elapsed.toFixed(2)),
      outPath,
    });

    return createCompilationResult(enriched, analysis, elapsed);
  }
}

export function build(opts?: Partial<CompilerOptions>): CompiledRoute {
  return new FluxCompiler(opts).compile();
}

export async function buildAsync(
  opts?: Partial<CompilerOptions>
): Promise<CompiledRoute> {
  return new FluxCompiler(opts).compileAsync();
}

if (import.meta.main) {
  await buildAsync();
}
