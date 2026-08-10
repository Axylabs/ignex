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
  CompilerContext,
  CompilerOptions,
  ModuleInfo,
  OptimizationResult,
  RouteDef,
} from "../types";

import { estimateNodeCount, handlerBodyReferencesImports } from "../utils/ast";

export const isInlineEligible = (
  route: RouteDef,
  mod: ModuleInfo | undefined,
  threshold: number,
): boolean => {
  if (!mod) return false;
  if (route.hasValidation) return false;
  if (route.hooks.length > 0) return false;
  if (route.isConstantResponse) return false;

  // A handler can only be inlined into the generated server when its body is
  // fully self-contained: imports that the body references would be dropped,
  // and no other top-level symbols the body could reference. Imports that only
  // feed the wrapper call (e.g. `get(...)`) or type-only imports do NOT block
  // inlining — the wrapper is extracted away, leaving only the body.
  if (handlerBodyReferencesImports(mod)) return false;
  const selfName = route.handlerExportName;
  const otherSymbols = selfName ? mod.symbols.filter((s) => s.name !== selfName) : mod.symbols;
  if (otherSymbols.length > 0) return false;

  const nodeCount = estimateNodeCount(mod.content);
  return nodeCount <= threshold;
};

export const markInline = (
  route: RouteDef,
  modules: readonly ModuleInfo[],
  threshold: number,
): RouteDef => {
  const mod = modules[route.moduleIdx];
  const shouldInline = isInlineEligible(route, mod, threshold);

  return shouldInline === route.shouldInline ? route : { ...route, shouldInline };
};

export const detectInlineCandidates = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  threshold: number,
): RouteDef[] => routes.map((r) => markInline(r, modules, threshold));

export const hasConstantResponse = (route: RouteDef): boolean =>
  route.isConstantResponse && !!route.constantResponse;

export const groupByConstantResponse = (routes: readonly RouteDef[]): Map<string, RouteDef[]> => {
  const groups = new Map<string, RouteDef[]>();

  for (const route of routes) {
    if (!hasConstantResponse(route)) continue;

    // Scope dedup to the same HTTP method: handler identifiers are per-method,
    // so a POST cannot reuse a GET handler.
    const key = `${route.method}:${route.constantResponse}`;
    const existing = groups.get(key);

    if (existing) existing.push(route);
    else groups.set(key, [route]);
  }

  return groups;
};

export const buildDedupMap = (groups: Map<string, RouteDef[]>): Map<string, string> => {
  const replacements = new Map<string, string>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const leader = group[0];
    if (!leader) continue;

    for (let i = 1; i < group.length; i++) {
      const member = group[i];
      if (!member) continue;
      replacements.set(member.handlerRef, leader.handlerRef);
    }
  }

  return replacements;
};

export const applyDedup = (route: RouteDef, dedupMap: Map<string, string>): RouteDef => {
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
  ctx: CompilerContext,
): OptimizationResult =>
  ctx.logger.time("optimization", () => {
    const inlined = detectInlineCandidates(routes, modules, opts.inlineThreshold);

    const deduped = opts.enableHandlerDeduplication ? deduplicateRoutes(inlined) : inlined;

    const inlinedCount = countInlined(deduped);
    const dedupedCount = countDeduped(deduped);

    ctx.logger.info(`Optimized: ${inlinedCount} inlined | ${dedupedCount} deduplicated`);

    return {
      routes: deduped,
      meta: {
        inlined: inlinedCount,
        deduplicated: dedupedCount,
        // A route whose handler is merged into the leader's no longer emits
        // its own handler — it is effectively eliminated from the output.
        eliminated: dedupedCount,
      },
    };
  });
