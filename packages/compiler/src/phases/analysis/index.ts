/**
 * @fileoverview ANALYSIS phase — orchestrator + public facade.
 *
 * The analysis pass is grouped by concern into focused modules:
 *   ./fs          — shared file reads
 *   ./app-config  — `app.config.ts` detection
 *   ./route-graph — `RouteIR` factory + graph building
 *   ./conflicts   — dead / duplicate / ambiguous route detection
 *   ./hooks       — route hook resolution
 *
 * `runAnalysis` composes these pure helpers; consumers import the whole phase
 * from `../phases/analysis` (this facade).
 */

export { resolveAppConfig } from "./app-config";
export type { RouteConflictIssue } from "./conflicts";
export { detectDeadRoutes, detectRouteConflicts } from "./conflicts";
export { resolveHooks } from "./hooks";
export {
  buildHandlerRef,
  buildRouteGraph,
  detectConstantResponse,
  findHandlerSymbol,
  findModuleByPath,
  findModuleIndex,
  parseRouteFile,
  resolveRouteModule,
} from "./route-graph";

import { DiagnosticCodes } from "../../diagnostics";
import type {
  AnalysisResult,
  CompilerContext,
  CompilerOptions,
  DiscoveryResult,
} from "../../types";
import { findResponseJsonReturn, nodeStart } from "../../utils/ast";
import { resolveAppConfig } from "./app-config";
import { detectDeadRoutes, detectRouteConflicts } from "./conflicts";
import { resolveHooks } from "./hooks";
import { buildRouteGraph, findHandlerSymbol } from "./route-graph";

/** Convert a source offset to a 1-based line / 0-based column position. */
const offsetToPosition = (source: string, offset: number): { line: number; column: number } => {
  const before = source.slice(0, offset);
  return {
    line: before.split("\n").length,
    column: offset - before.lastIndexOf("\n") - 1,
  };
};

export const runAnalysis = (
  discovery: DiscoveryResult,
  opts: CompilerOptions,
  ctx: CompilerContext,
): AnalysisResult =>
  ctx.logger.time("analysis", () => {
    const routes = buildRouteGraph(discovery.files, discovery.modules);
    const { alive, dead } = detectDeadRoutes(routes, discovery.modules);

    if (dead.length > 0) {
      for (const r of dead) {
        ctx.diagnostics.warn({
          code: DiagnosticCodes.DeadRoute,
          message: `Route eliminated (dead or duplicate): ${r.source.method} ${r.source.path}`,
          file: r.source.file,
        });
      }
    }

    detectRouteConflicts(alive, opts, ctx);

    // Compile-time enforcement: flag route handlers that return
    // `Response.json(...)` directly. That bypasses the AOT optimizations
    // (jsonReply pre-encoding + exact content-length + schema serializer) and
    // is a per-request runtime call. Steer to `ctx.json(...)` / plain-value
    // returns so the compiler can optimize the response at build time.
    for (const route of alive) {
      const mod = discovery.modules[route.source.moduleIdx];
      if (!mod?.ast) continue;
      const call = findResponseJsonReturn(mod.ast);
      if (!call) continue;
      const offset = nodeStart(call);
      ctx.diagnostics.warn({
        code: DiagnosticCodes.NonOptimizableResponse,
        message:
          `Route handler returns Response.json(...) directly, bypassing AOT optimizations. ` +
          `Prefer ctx.json(...) (pre-encoded body + exact content-length + schema serializer) ` +
          `or a plain-value return with a response schema for a compile-time-optimized response.`,
        file: route.source.file,
        ...(offset !== undefined ? { position: offsetToPosition(mod.content, offset) } : {}),
      });
    }

    const modules = discovery.modules;

    // Hotness = handler symbol fan-in (calls within its module) + the number
    // of routes sharing the same module (shared-handler pressure).
    const shared = new Map<number, number>();
    for (const route of alive) {
      shared.set(route.source.moduleIdx, (shared.get(route.source.moduleIdx) ?? 0) + 1);
    }
    const routesWithHotness = alive.map((route) => {
      const mod = modules[route.source.moduleIdx];
      const handlerSym = mod ? findHandlerSymbol(mod) : undefined;
      const score = (handlerSym?.hotness ?? 0) + (shared.get(route.source.moduleIdx) ?? 1);
      return score === route.analysis.hotnessScore
        ? route
        : { ...route, analysis: { ...route.analysis, hotnessScore: score } };
    });

    const hooks = resolveHooks(routesWithHotness, opts.hooksDir, discovery.sources, ctx);
    const appConfig = resolveAppConfig(opts, discovery.sources, ctx);

    if (appConfig) {
      ctx.logger.info(`App config found: ${appConfig.relPath}`, {
        plugins: appConfig.hasPlugins,
        lifecycle: appConfig.hasLifecycle,
        server: appConfig.hasServer,
      });
    }

    return {
      routes: routesWithHotness,
      modules,
      hooks,
      ...(appConfig ? { appConfig } : {}),
    };
  });
