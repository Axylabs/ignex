/**
 * @fileoverview Analysis: route graph construction.
 *
 * Builds `RouteIR`s from discovered modules: filename parsing, constant
 * response detection, handler refs, cache normalization and the graph.
 *
 * Lowering (filename + AST → {@link RouteIR}) lives in `../../ir/lower`; this
 * module orchestrates it over the discovered sources and keeps the
 * module-table helpers used by the rest of the analysis phase.
 */

import { lowerRoute, parseRouteFilename } from "../../ir/lower";
import type { RouteIR } from "../../ir/route";
import type { ModuleInfo } from "../../types";

export const parseRouteFile = (file: string) => parseRouteFilename(file);

export const findModuleByPath = (
  modules: readonly ModuleInfo[],
  relPath: string,
): ModuleInfo | undefined => modules.find((m) => m.relPath === relPath);

export const findModuleIndex = (modules: readonly ModuleInfo[], relPath: string): number =>
  modules.findIndex((m) => m.relPath === relPath);

// ── RouteIR factory ──────────────────────────────────────────────

// Re-export the lowering helpers so the analysis facade keeps its surface
// (internal-only consumers; no public API change).
export {
  buildHandlerRef,
  detectConstantResponse,
  findHandlerSymbol,
} from "../../ir/lower";

export const resolveRouteModule = (
  file: string,
  modules: readonly ModuleInfo[],
): { mod: ModuleInfo; parsed: NonNullable<ReturnType<typeof parseRouteFilename>> } | null => {
  const parsed = parseRouteFile(file);
  if (!parsed) return null;
  const mod = findModuleByPath(modules, file);
  if (!mod) return null;
  // Accept default-export handlers AND named-export handlers
  // (`export const httpGet = get(...)`, `export function httpGet(...)`).
  // WebSocket routes (`*.ws.ts`) export `wsHandler` instead — allow those too.
  if (!mod.hasHandlerExport && parsed.method !== "WS") return null;
  return { mod, parsed };
};

export const buildRouteGraph = (
  files: readonly string[],
  modules: readonly ModuleInfo[],
): RouteIR[] => {
  const routes: RouteIR[] = [];

  for (const file of files) {
    const resolved = resolveRouteModule(file, modules);
    if (!resolved) continue;

    const moduleIdx = findModuleIndex(modules, file);
    if (moduleIdx < 0) continue;

    routes.push(lowerRoute(file, resolved.parsed, resolved.mod, routes.length, moduleIdx));
  }

  return routes;
};
