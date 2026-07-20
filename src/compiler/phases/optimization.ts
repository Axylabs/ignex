/**
 * @fileoverview Phase 3: OPTIMIZATION
 * Composable pure transforms: inline → dedup → trie → jump table → buffers.
 */

import type {
  RouteDef,
  ModuleInfo,
  SegNode,
  CompilerOptions,
  JumpTable,
  OptimizationResult,
} from "../types";

import { buildTrie, trieStats } from "../utils/trie";
import { canUseDenseArray, generatePerfectHash } from "../utils/hash";
import { estimateNodeCount } from "../utils/ast";
import type { Logger } from "../logger";

// ============================================================================
// Inline Detection — Pure
// ============================================================================

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

// ============================================================================
// Route Deduplication — Pure
// ============================================================================

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

// ============================================================================
// Jump Table — Pure
// ============================================================================

export const selectJumpStrategy = (
  hashes: readonly number[]
): JumpTable["strategy"] => {
  if (hashes.length === 0) return "sparse";
  if (canUseDenseArray(hashes)) return "dense";
  if (generatePerfectHash(hashes)) return "perfect-hash";
  return "sparse";
};



export const detectCollisions = (
  staticRoutes: readonly RouteDef[]
): Map<number, readonly number[]> => {
  const collisions = new Map<number, number[]>();
  const seen = new Map<number, number>();
  for (let i = 0; i < staticRoutes.length; i++) {
    const route = staticRoutes[i];
    if (!route) continue;
    const h = route.signatureHash;
    const prev = seen.get(h);
    if (prev !== undefined) {
      const existing = collisions.get(h);
      if (existing) existing.push(i);
      else collisions.set(h, [prev, i]);
    } else {
      seen.set(h, i);
    }
  }
  return collisions;
};

// ============================================================================
// Response Preserialization — Pure
// ============================================================================

export const makeErrorBuf = (msg: string): string =>
  `new TextEncoder().encode(JSON.stringify({error:"${msg}"}))`;

export const buildErrorBuffers = (): Map<string, string> => {
  const buffers = new Map<string, string>();
  buffers.set("404", makeErrorBuf("Not Found"));
  buffers.set("400", makeErrorBuf("Bad Request"));
  buffers.set("500", makeErrorBuf("Internal Server Error"));
  buffers.set("401", makeErrorBuf("Unauthorized"));
  buffers.set("403", makeErrorBuf("Forbidden"));
  return buffers;
};

export const makeRouteBuf = (route: RouteDef): [string, string] | null => {
  if (!route.isConstantResponse || !route.constantResponse) return null;
  const key = `route_${route.handlerRef}`;
  const value = `new TextEncoder().encode(JSON.stringify(${route.constantResponse}))`;
  return [key, value];
};

export const preserializeResponses = (routes: readonly RouteDef[]): Map<string, string> => {
  const buffers = buildErrorBuffers();
  for (const route of routes) {
    const pair = makeRouteBuf(route);
    if (pair) buffers.set(pair[0], pair[1]);
  }
  return buffers;
};

// ============================================================================
// Schema Compilation — Pure
// ============================================================================

export const compileStringSchema = (): string => `typeof ctx.body === "string"`;
export const compileNumberSchema = (): string => `typeof ctx.body === "number"`;
export const compileBooleanSchema = (): string => `typeof ctx.body === "boolean"`;
export const compileArraySchema = (): string => `Array.isArray(ctx.body)`;

export const extractObjectProps = (schemaCode: string): string[] | null => {
  const props = schemaCode.match(/([\w$]+):\s*z\.\w+\(\)/g);
  if (!props) return null;
  return props.map((p) => p.split(":")[0]!.trim());
};

export const compileObjectSchema = (schemaCode: string): string | null => {
  const props = extractObjectProps(schemaCode);
  if (!props) return null;
  const checks = props.map((name) => `typeof ctx.body.${name} !== "undefined"`);
  return `typeof ctx.body === "object" && ctx.body !== null && ${checks.join(" && ")}`;
};

export const compileSchema = (schemaCode: string): string | null => {
  if (schemaCode.includes("z.string()")) return compileStringSchema();
  if (schemaCode.includes("z.number()")) return compileNumberSchema();
  if (schemaCode.includes("z.boolean()")) return compileBooleanSchema();
  if (schemaCode.includes("z.array(")) return compileArraySchema();
  if (schemaCode.includes("z.object")) return compileObjectSchema(schemaCode);
  return null;
};

// ============================================================================
// Route Partitioning — Pure
// ============================================================================

export const partitionRoutes = (routes: readonly RouteDef[]): [RouteDef[], RouteDef[]] =>
  routes.reduce(
    ([s, d], r) => (r.isStatic ? [[...s, r], d] : [s, [...d, r]]),
    [[], []] as [RouteDef[], RouteDef[]]
  );

// ============================================================================
// Statistics — Pure
// ============================================================================

export const countInlined = (routes: readonly RouteDef[]): number =>
  routes.filter((r) => r.shouldInline).length;

export const countDeduped = (routes: readonly RouteDef[]): number =>
  routes.filter((r) => r.dedupGroup).length;

// ============================================================================
// Phase Orchestrator — Composed pipeline
// ============================================================================

export const runOptimization = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  opts: CompilerOptions,
  logger: Logger
): OptimizationResult =>
  logger.time("optimization", () => {
    // Pipeline: inline → dedup → partition → build structures
    const inlined = detectInlineCandidates(routes, modules, opts.inlineThreshold);
    const deduped = opts.enableHandlerDeduplication
      ? deduplicateRoutes(inlined)
      : inlined;

    const [statics, dynamics] = partitionRoutes(deduped);
    const trie = buildTrie(dynamics);
    const jumpTable = buildJumpTable(statics);
    const buffers = preserializeResponses(deduped);

    const stats = trieStats(trie);
    const inlinedCount = countInlined(deduped);
    const dedupedCount = countDeduped(deduped);

    logger.info(
      `Optimized: ${inlinedCount} inlined | ${dedupedCount} deduplicated | jumpTable=${jumpTable.strategy}`
    );
    logger.info(
      `Trie: ${stats.totalNodes} nodes, depth ${stats.maxDepth}, avg branching ${stats.avgBranching.toFixed(2)}`
    );

    return {
      routes: deduped,
      trie,
      jumpTable,
      preserializedBuffers: buffers,
      meta: {
        inlined: inlinedCount,
        deduplicated: dedupedCount,
        eliminated: routes.length - deduped.length,
      },
    };
  });





  const globalRouteIndex = (route: RouteDef): number => {
  const match = /^_h(\d+)$/.exec(route.handlerRef);
  return match ? Number.parseInt(match[1]!, 10) : 0;
};

export const buildDenseTable = (
  staticRoutes: readonly RouteDef[],
  min: number,
  max: number
): Array<{ hash: number; routeIdx: number } | null> => {
  const size = max - min + 1;
  const entries = new Array(size).fill(null) as Array<{
    hash: number;
    routeIdx: number;
  } | null>;

  for (const route of staticRoutes) {
    const idx = route.signatureHash - min;

    if (idx >= 0 && idx < entries.length) {
      entries[idx] = {
        hash: route.signatureHash,
        routeIdx: globalRouteIndex(route),
      };
    }
  }

  return entries;
};

export const buildSparseTable = (
  staticRoutes: readonly RouteDef[]
): Array<{ hash: number; routeIdx: number }> => {
  return staticRoutes
    .map((r) => ({
      hash: r.signatureHash,
      routeIdx: globalRouteIndex(r),
    }))
    .sort((a, b) => a.hash - b.hash);
};

export const buildPerfectHashTable = (
  staticRoutes: readonly RouteDef[],
  seed: number
): Array<{ hash: number; routeIdx: number } | null> => {
  const n = staticRoutes.length;
  if (n === 0) return [];

  const entries = new Array(n).fill(null) as Array<{
    hash: number;
    routeIdx: number;
  } | null>;

  for (const route of staticRoutes) {
    const idx = ((route.signatureHash + seed) % n + n) % n;

    entries[idx] = {
      hash: route.signatureHash,
      routeIdx: globalRouteIndex(route),
    };
  }

  return entries;
};

export const buildJumpTableEntries = (
  staticRoutes: readonly RouteDef[],
  strategy: JumpTable["strategy"],
  min: number,
  max: number,
  seed = 0
): Array<{ hash: number; routeIdx: number } | null> => {
  switch (strategy) {
    case "dense":
      return buildDenseTable(staticRoutes, min, max);

    case "perfect-hash":
      return buildPerfectHashTable(staticRoutes, seed);

    case "sparse":
      return buildSparseTable(staticRoutes);
  }
};

export const emitDenseLookup = (min: number, max: number): string =>
  `const idx = hash - ${min}; return idx >= 0 && idx < ${
    max - min + 1
  } ? table[idx] : null;`;

export const emitPerfectHashLookup = (len: number, seed = 0): string =>
  `const entry = table[(hash + ${seed}) % ${len}]; return entry && entry.hash === hash ? entry : null;`;

export const emitSparseLookup = (): string =>
  `// binary search implementation`;

export const generateLookupCode = (
  strategy: JumpTable["strategy"],
  min: number,
  max: number,
  len: number,
  seed = 0
): string => {
  if (len === 0) return `return null;`;

  switch (strategy) {
    case "dense":
      return emitDenseLookup(min, max);

    case "perfect-hash":
      return emitPerfectHashLookup(len, seed);

    case "sparse":
      return emitSparseLookup();
  }
};

export const buildJumpTable = (staticRoutes: readonly RouteDef[]): JumpTable => {
  const hashes = staticRoutes.map((r) => r.signatureHash);

  const perfect =
    hashes.length > 0 && hashes.length <= 100
      ? generatePerfectHash(hashes)
      : null;

  const strategy: JumpTable["strategy"] =
    hashes.length === 0
      ? "sparse"
      : canUseDenseArray(hashes)
        ? "dense"
        : perfect
          ? "perfect-hash"
          : "sparse";

  const min = hashes.length > 0 ? Math.min(...hashes) : 0;
  const max = hashes.length > 0 ? Math.max(...hashes) : 0;

  const seed =
    strategy === "perfect-hash" ? perfect?.g[0] ?? 0 : undefined;

  const entries = buildJumpTableEntries(
    staticRoutes,
    strategy,
    min,
    max,
    seed ?? 0
  );

  const collisions = detectCollisions(staticRoutes);

  return {
    strategy,
    entries,
    minHash: min,
    maxHash: max,
    collisions,
    lookupCode: generateLookupCode(
      strategy,
      min,
      max,
      entries.length,
      seed ?? 0
    ),
    seed,
  };
};