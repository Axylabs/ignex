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
export { detectDeadRoutes, detectRouteConflicts, staticRouteKey } from "./conflicts";
export { collectHookNames, resolveHook, resolveHooks } from "./hooks";
export {
  buildHandlerRef,
  buildRouteGraph,
  createRouteDef,
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
import { resolveAppConfig } from "./app-config";
import { detectDeadRoutes, detectRouteConflicts } from "./conflicts";
import { resolveHooks } from "./hooks";
import { buildRouteGraph, findHandlerSymbol } from "./route-graph";

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
