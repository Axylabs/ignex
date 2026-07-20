/**
 * @fileoverview FLUX ENTERPRISE COMPILER v2.0 — Refactored Orchestrator
 * Main entry point with small, composable pure functions.
 */

import type {
  CompilerOptions,
  CompiledRoute,
  DiscoveryResult,
  AnalysisResult,
  HookDef,
  OptimizationResult,
} from "./types";

import type { Logger } from "./logger";
import { DEFAULT_OPTS } from "./types";
import { runDiscovery } from "./phases/discovery";
import { runAnalysis } from "./phases/analysis";
import { runOptimization } from "./phases/optimization";
import { runCodeGen } from "./phases/codegen";
import { runLinker } from "./phases/linker";
import { consoleLogger } from "./logger";
import { trieStats } from "./utils/trie"; // FIXED: direct import instead of require()

export { DEFAULT_OPTS };
export type { CompilerOptions, CompiledRoute };

// ============================================================================
// Options — Pure
// ============================================================================

import { defu } from "defu";

export const mergeOptions = (
  opts: Partial<CompilerOptions>
): CompilerOptions => defu(opts, DEFAULT_OPTS) as CompilerOptions;

// ============================================================================
// Logging — Pure Formatters
// ============================================================================

export const formatBanner = (opts: CompilerOptions): string =>
  `🔥 Flux Enterprise Compiler v2.0\n` +
  `   Target: ${opts.target} | OptLevel: ${opts.optimizationLevel}\n` +
  `   Features: SIMD=${opts.enableSIMDPaths} | BranchPred=${opts.enableBranchPrediction} | DCE=${opts.enableDeadCodeElimination}`;

export const formatDiscoveryStats = (discovery: DiscoveryResult): string =>
  `   ${discovery.files.length} files | ${discovery.modules.length} modules`;

export const formatAnalysisStats = (analysis: AnalysisResult): string => {
  const staticCount = analysis.routes.filter((r) => r.isStatic).length;
  const dynamicCount = analysis.routes.filter((r) => r.isDynamic).length;
  const constantCount = analysis.routes.filter((r) => r.isConstantResponse).length;
  return `   ${analysis.routes.length} routes (${staticCount} static, ${dynamicCount} dynamic, ${constantCount} constant)`;
};

export const formatHooks = (hooks: ReadonlyMap<string, HookDef>): string | null =>
  hooks.size > 0 ? `   Hooks: ${[...hooks.keys()].join(", ")}` : null;

export const formatOptimizationStats = (optimized: OptimizationResult): string =>
  `   ${optimized.meta.inlined} inlined | ${optimized.meta.deduplicated} deduplicated\n` +
  `   Jump table: ${optimized.jumpTable.strategy} | ${optimized.jumpTable.entries.length} entries`;

export const formatTrieStats = (stats: {
  totalNodes: number; maxDepth: number; avgBranching: number;
}): string =>
  `   Trie: ${stats.totalNodes} nodes | depth ${stats.maxDepth} | avg branching ${stats.avgBranching.toFixed(2)}`;

export const formatCodegenStats = (code: string): string =>
  `   ${code.split("\n").length} lines emitted`;

export const formatCompletion = (elapsedMs: number, outPath: string): string =>
  `\n✅ Build complete in ${elapsedMs.toFixed(2)}ms → ${outPath}`;

// ============================================================================
// Result Factory — Pure
// ============================================================================

export const createCompilationResult = (
  optimized: OptimizationResult,
  analysis: AnalysisResult,
  elapsedMs: number
): CompiledRoute => ({
  staticRoutes: optimized.routes.filter((r) => r.isStatic),
  dynamicRoutes: optimized.routes.filter((r) => r.isDynamic),
  trie: optimized.trie,
  modules: analysis.modules,
  jumpTable: optimized.jumpTable,
  meta: {
    inlinedHandlers: optimized.meta.inlined,
    deduplicatedHandlers: optimized.meta.deduplicated,
    eliminatedRoutes: optimized.meta.eliminated,
    preserializedResponses: optimized.preserializedBuffers.size,
    totalCompileTime: elapsedMs,
  },
});

// ============================================================================
// Phase Runners — Pure Orchestration with Functional Composition
// ============================================================================

export const runDiscoveryPhase = (opts: CompilerOptions, logger: Logger): DiscoveryResult => {
  console.log("\n📡 Phase 1: Discovery");
  const result = runDiscovery(opts, logger);
  console.log(formatDiscoveryStats(result));
  return result;
};

export const runAnalysisPhase = (
  discovery: DiscoveryResult,
  opts: CompilerOptions,
  logger: Logger
): AnalysisResult => {
  console.log("\n🔬 Phase 2: Analysis");
  const result = runAnalysis(discovery, opts, logger);
  console.log(formatAnalysisStats(result));
  const hooksStr = formatHooks(result.hooks);
  if (hooksStr) console.log(hooksStr);
  return result;
};

export const runOptimizationPhase = (
  analysis: AnalysisResult,
  opts: CompilerOptions,
  logger: Logger
): OptimizationResult => {
  console.log("\n⚡ Phase 3: Optimization");
  const result = runOptimization(analysis.routes, analysis.modules, opts, logger);
  console.log(formatOptimizationStats(result));
  const stats = trieStats(result.trie); // FIXED: direct import
  console.log(formatTrieStats(stats));
  return result;
};

export const runCodegenPhase = (
  optimized: OptimizationResult,
  analysis: AnalysisResult,
  opts: CompilerOptions,
  logger: Logger
): string => {
  console.log("\n📝 Phase 4: Code Generation");
  const code = runCodeGen(
    optimized.routes,
    optimized.trie,
    optimized.jumpTable,
    analysis.modules,
    analysis.hooks,
    optimized.preserializedBuffers,
    opts,
    logger
  );
  console.log(formatCodegenStats(code));
  return code;
};

export const runLinkingPhase = (
  code: string,
  opts: CompilerOptions,
  logger: Logger
): string => {
  console.log("\n🔗 Phase 5: Linking");
  return runLinker(code, opts, logger);
};

// ============================================================================
// Compiler Class
// ============================================================================

export class FluxCompiler {
  private opts: CompilerOptions;

  constructor(opts: Partial<CompilerOptions> = {}) {
    this.opts = mergeOptions(opts);
  }

  compile(): CompiledRoute {
    const t0 = performance.now();
    const logger = consoleLogger();

    console.log(formatBanner(this.opts));

    // Functional pipeline: discovery → analysis → optimization → codegen → link
    const discovery = runDiscoveryPhase(this.opts, logger);
    const analysis = runAnalysisPhase(discovery, this.opts, logger);
    const optimized = runOptimizationPhase(analysis, this.opts, logger);
    const code = runCodegenPhase(optimized, analysis, this.opts, logger);
    const outPath = runLinkingPhase(code, this.opts, logger);

    const elapsed = performance.now() - t0;
    console.log(formatCompletion(elapsed, outPath));

    return createCompilationResult(optimized, analysis, elapsed);
  }
}

export function build(opts?: Partial<CompilerOptions>): CompiledRoute {
  return new FluxCompiler(opts).compile();
}

if (import.meta.main) {
  build();
}