/**
 * Phase 3: OPTIMIZATION
 *
 * A pure IR transform: reads `RouteIR.analysis`, writes `RouteIR.decisions`
 * (`shouldInline`, `dedupGroup`, `inlineCandidate`). Codegen then only READS
 * the finalized decisions — it never re-derives inline eligibility or
 * re-transpiles handler bodies.
 */

import type { InlineCandidate } from "../ir/route";
import type {
  CompilerContext,
  CompilerOptions,
  ModuleInfo,
  OptimizationResult,
  RouteDef,
} from "../types";
import {
  estimateNodeCount,
  handlerBodyReferencesImports,
  handlerBodyReferencesModuleScope,
  isPlainJavaScriptBody,
} from "../utils/ast";

export const isInlineEligible = (
  route: RouteDef,
  mod: ModuleInfo | undefined,
  threshold: number,
): boolean => {
  if (!mod) return false;
  if (route.analysis.hasValidation) return false;
  if (route.analysis.hooks.length > 0) return false;
  if (route.analysis.isConstantResponse) return false;

  // A handler can only be inlined into the generated server when its body is
  // fully self-contained: imports that the body references would be dropped,
  // no other top-level symbols the body could reference, and no module-scope
  // bindings the body closes over (inlining drops module scope). Imports that
  // only feed the wrapper call (e.g. `get(...)`) or type-only imports do NOT
  // block inlining — the wrapper is extracted away, leaving only the body.
  if (handlerBodyReferencesImports(mod)) return false;
  if (handlerBodyReferencesModuleScope(mod)) return false;
  const selfName = route.analysis.handlerExportName;
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
  const mod = modules[route.source.moduleIdx];
  const shouldInline = isInlineEligible(route, mod, threshold);

  return shouldInline === route.decisions.shouldInline
    ? route
    : { ...route, decisions: { ...route.decisions, shouldInline } };
};

export const detectInlineCandidates = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  threshold: number,
): RouteDef[] => routes.map((r) => markInline(r, modules, threshold));

// ── Inline candidate resolution (moved out of codegen) ───────────

/**
 * Transpile a handler body from TS to plain JS so it can be safely inlined
 * into the generated `.js` server. Returns `null` when the body cannot be
 * made into safe JS — inlining is then skipped and the handler is imported
 * (and TS-transpiled by the runtime/bundler) instead.
 *
 * When `Bun.Transpiler` is unavailable (e.g. vitest workers), falls back to a
 * plain-JavaScript parse check: only bodies that are already plain JS are
 * inlined raw.
 */
export const transpileHandlerBody = (body: string, isAsync: boolean): string | null => {
  const bun = (
    globalThis as {
      Bun?: {
        Transpiler?: new (opts: { loader: string }) => { transformSync(code: string): string };
      };
    }
  ).Bun;

  if (bun?.Transpiler) {
    try {
      const t = new bun.Transpiler({ loader: "ts" });
      // Wrap so top-level `return` / `await` are legal, then extract the inner
      // body from the transpiled (type-erased) function.
      const wrapped = t.transformSync(
        `${isAsync ? "async " : ""}function __fluxInline() { ${body} }`,
      );
      const start = wrapped.indexOf("{");
      const end = wrapped.lastIndexOf("}");
      if (start === -1 || end <= start) return null;
      return wrapped.slice(start + 1, end).trim();
    } catch {
      // fall through to the plain-JS check
    }
  }

  if (isPlainJavaScriptBody(body, isAsync)) return body;
  return null;
};

/**
 * Resolve the inline candidate for an eligible route (or `null`). A handler
 * can be inlined (instead of imported) when its module is fully
 * self-contained: no imports the body references, no other top-level symbols,
 * a simple identifier parameter, and a body under `maxInlineBytes`. The body
 * is transpiled to plain JS so TS-only syntax never leaks into the output.
 *
 * Reads the handler retained on the {@link ModuleInfo}/{@link SourceFile} —
 * no re-parse of `content`.
 */
export const resolveInlineCandidate = (
  route: RouteDef,
  mod: ModuleInfo | undefined,
  opts: CompilerOptions,
): InlineCandidate | null => {
  if (!route.decisions.shouldInline) return null;
  if (!mod) return null;
  // Imports referenced by the handler body would be dropped when inlined;
  // imports that only feed the wrapper call / type-only imports are fine.
  if (handlerBodyReferencesImports(mod)) return null;

  // The named-export handler's own symbol is fine; any OTHER top-level symbol
  // means the module is not fully self-contained.
  const selfName = route.analysis.handlerExportName;
  const otherSymbols = selfName ? mod.symbols.filter((s) => s.name !== selfName) : mod.symbols;
  if (otherSymbols.length > 0) return null;

  const handler = mod.handler;
  if (!handler?.body || !handler.isSimpleParam) return null;
  if (handler.body.length > (opts.maxInlineBytes ?? 2048)) return null;

  const body = transpileHandlerBody(handler.body, handler.isAsync);
  if (body === null) return null;

  return {
    body,
    isAsync: handler.isAsync,
    param: handler.paramName,
  };
};

/** Store the transpiled inline candidate on every eligible route. */
export const computeInlineCandidates = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  opts: CompilerOptions,
): RouteDef[] =>
  routes.map((route) => {
    const inline = resolveInlineCandidate(route, modules[route.source.moduleIdx], opts);
    if (!inline) return route;
    return { ...route, decisions: { ...route.decisions, inlineCandidate: inline } };
  });

// ── Constant-response deduplication ──────────────────────────────

export const hasConstantResponse = (route: RouteDef): boolean =>
  route.analysis.isConstantResponse && !!route.analysis.constantResponse;

export const groupByConstantResponse = (routes: readonly RouteDef[]): Map<string, RouteDef[]> => {
  const groups = new Map<string, RouteDef[]>();

  for (const route of routes) {
    if (!hasConstantResponse(route)) continue;

    // Scope dedup to the same HTTP method: handler identifiers are per-method,
    // so a POST cannot reuse a GET handler.
    const key = `${route.source.method}:${route.analysis.constantResponse}`;
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
      replacements.set(member.codegen.handlerRef, leader.codegen.handlerRef);
    }
  }

  return replacements;
};

export const applyDedup = (route: RouteDef, dedupMap: Map<string, string>): RouteDef => {
  const dedupGroup = dedupMap.get(route.codegen.handlerRef);
  return dedupGroup ? { ...route, decisions: { ...route.decisions, dedupGroup } } : route;
};

export const deduplicateRoutes = (routes: RouteDef[]): RouteDef[] => {
  const groups = groupByConstantResponse(routes);
  const dedupMap = buildDedupMap(groups);

  if (dedupMap.size === 0) return routes;

  return routes.map((r) => applyDedup(r, dedupMap));
};

export const countInlined = (routes: readonly RouteDef[]): number =>
  routes.filter((r) => r.decisions.shouldInline).length;

export const countDeduped = (routes: readonly RouteDef[]): number =>
  routes.filter((r) => r.decisions.dedupGroup).length;

export const runOptimization = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  opts: CompilerOptions,
  ctx: CompilerContext,
): OptimizationResult =>
  ctx.logger.time("optimization", () => {
    const inlined = detectInlineCandidates(routes, modules, opts.inlineThreshold);

    const deduped = opts.enableHandlerDeduplication ? deduplicateRoutes(inlined) : inlined;

    // Resolve + transpile inline candidates up-front so codegen only reads
    // `decisions.inlineCandidate` (no re-derivation, no re-transpile).
    const finalized = computeInlineCandidates(deduped, modules, opts);

    const inlinedCount = countInlined(finalized);
    const dedupedCount = countDeduped(finalized);

    ctx.logger.info(`Optimized: ${inlinedCount} inlined | ${dedupedCount} deduplicated`);

    return {
      routes: finalized,
      meta: {
        inlined: inlinedCount,
        deduplicated: dedupedCount,
        // A route whose handler is merged into the leader's no longer emits
        // its own handler — it is effectively eliminated from the output.
        eliminated: dedupedCount,
      },
    };
  });
