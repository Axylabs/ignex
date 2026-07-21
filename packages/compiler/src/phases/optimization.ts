/**
 * Phase 3: OPTIMIZATION
 *
 * Production cleanup:
 * - removed jump table generation
 * - removed dense/sparse/perfect-hash tables
 * - removed response preserialization buffers
 * - removed Zod-specific schema compilation
 * - kept inline detection and deduplication
 */

import type {
  RouteDef,
  ModuleInfo,
  CompilerOptions,
  OptimizationResult,
} from "../types";

import { estimateNodeCount } from "../utils/ast";
import type { Logger } from "../logger";

export const isInlineEligible = (
  route: RouteDef,
  mod: ModuleInfo | undefined,
  threshold: number
): boolean => {
  if (!mod) return false;
  if (route.hasValidation) return false;
  if (route.hooks.length > 0) return false;

  const nodeCount = estimateNodeCount(mod.content);
  return nodeCount <= threshold;
};

export const markInline = (
  route: RouteDef,
  modules: readonly ModuleInfo[],
  threshold: number
): RouteDef => {
  const mod = modules[route.moduleIdx];
  const shouldInline = isInlineEligible(route, mod, threshold);

  return shouldInline === route.shouldInline ? route : { ...route, shouldInline };
};

export const detectInlineCandidates = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  threshold: number
): RouteDef[] => routes.map((r) => markInline(r, modules, threshold));

export const hasConstantResponse = (route: RouteDef): boolean =>
  route.isConstantResponse && !!route.constantResponse;

export const groupByConstantResponse = (
  routes: readonly RouteDef[]
): Map<string, RouteDef[]> => {
  const groups = new Map<string, RouteDef[]>();

  for (const route of routes) {
    if (!hasConstantResponse(route)) continue;

    const key = route.constantResponse!;
    const existing = groups.get(key);

    if (existing) existing.push(route);
    else groups.set(key, [route]);
  }

  return groups;
};

export const buildDedupMap = (
  groups: Map<string, RouteDef[]>
): Map<string, string> => {
  const replacements = new Map<string, string>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const leader = group[0]!;

    for (let i = 1; i < group.length; i++) {
      replacements.set(group[i]!.handlerRef, leader.handlerRef);
    }
  }

  return replacements;
};

export const applyDedup = (
  route: RouteDef,
  dedupMap: Map<string, string>
): RouteDef => {
  const dedupGroup = dedupMap.get(route.handlerRef);
  return dedupGroup ? { ...route, dedupGroup } : route;
};

export const deduplicateRoutes = (routes: RouteDef[]): RouteDef[] => {
  const groups = groupByConstantResponse(routes);
  const dedupMap = buildDedupMap(groups);

  if (dedupMap.size === 0) return routes;

  return routes.map((r) => applyDedup(r, dedupMap));
};

export const countInlined = (routes: readonly RouteDef[]): number =>
  routes.filter((r) => r.shouldInline).length;

export const countDeduped = (routes: readonly RouteDef[]): number =>
  routes.filter((r) => r.dedupGroup).length;

export const runOptimization = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  opts: CompilerOptions,
  logger: Logger
): OptimizationResult =>
  logger.time("optimization", () => {
    const inlined = detectInlineCandidates(routes, modules, opts.inlineThreshold);

    const deduped = opts.enableHandlerDeduplication
      ? deduplicateRoutes(inlined)
      : inlined;

    const inlinedCount = countInlined(deduped);
    const dedupedCount = countDeduped(deduped);

    logger.info(
      `Optimized: ${inlinedCount} inlined | ${dedupedCount} deduplicated`
    );

    return {
      routes: deduped,
      meta: {
        inlined: inlinedCount,
        deduplicated: dedupedCount,
        eliminated: routes.length - deduped.length,
      },
    };
  });
