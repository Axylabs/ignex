/**
 * @fileoverview ANALYSIS phase — orchestrator + public facade.
 *
 * The analysis pass is grouped by concern into focused modules:
 *   ./fs          — shared file reads
 *   ./app-config  — `app.config.ts` detection
 *   ./route-graph — `RouteDef` factory + graph building
 *   ./conflicts   — dead / duplicate / ambiguous route detection
 *   ./hooks       — route hook resolution
 *   ./stats       — route counters
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
  computeMethodIndex,
  createRouteDef,
  detectConstantResponse,
  findHandlerSymbol,
  findModuleByPath,
  findModuleIndex,
  parseRouteFile,
  resolveRouteModule,
} from "./route-graph";
export { countConstant, countDynamic, countRoutes, countStatic } from "./stats";

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
    const routes = buildRouteGraph(discovery.files, discovery.modules, ctx.diagnostics);
    const { alive, dead } = detectDeadRoutes(routes, discovery.modules);

    if (dead.length > 0) {
      for (const r of dead) {
        ctx.diagnostics.warn({
          code: DiagnosticCodes.DeadRoute,
          message: `Route eliminated (dead or duplicate): ${r.method} ${r.path}`,
          file: r.file,
        });
      }
    }

    detectRouteConflicts(alive, opts, ctx);

    const modules = discovery.modules;

    // Hotness = handler symbol fan-in (calls within its module) + the number
    // of routes sharing the same module (shared-handler pressure).
    const shared = new Map<number, number>();
    for (const route of alive) {
      shared.set(route.moduleIdx, (shared.get(route.moduleIdx) ?? 0) + 1);
    }
    const routesWithHotness = alive.map((route) => {
      const mod = modules[route.moduleIdx];
      const handlerSym = mod ? findHandlerSymbol(mod) : undefined;
      const score = (handlerSym?.hotness ?? 0) + (shared.get(route.moduleIdx) ?? 1);
      return score === route.hotnessScore ? route : { ...route, hotnessScore: score };
    });

    const hooks = resolveHooks(routesWithHotness, opts.hooksDir, ctx);
    const appConfig = resolveAppConfig(opts);

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
