/**
 * Phase 3: OPTIMIZATION
 *
 * A pure IR transform: reads `RouteIR.analysis`, writes `RouteIR.decisions`
 * (`shouldInline`, `dedupGroup`, `inlineCandidate`). Codegen then only READS
 * the finalized decisions — it never re-derives inline eligibility or
 * re-transpiles handler bodies.
 */

import { DiagnosticCodes } from "../diagnostics";
import type { InlineCandidate } from "../ir/route";
import type {
  CompilerContext,
  CompilerOptions,
  ModuleInfo,
  OptimizationResult,
  RouteIR,
} from "../types";
import {
  estimateNodeCount,
  handlerBodyReferencesImports,
  handlerBodyReferencesModuleScope,
  isPlainJavaScriptBody,
} from "../utils/ast";

export const isInlineEligible = (
  route: RouteIR,
  mod: ModuleInfo | undefined,
  threshold: number,
): boolean => {
  if (!mod) return false;
  if (route.analysis.hasValidation) return false;
  if (route.analysis.hooks.length > 0) return false;
  if (route.analysis.isConstantResponse) return false;

  // SECURITY: opaque guards (`PERMS.X` constants the evaluator cannot fold)
  // mean the static guard chain is incomplete. Inlining drops the runtime
  // `withGuards` wrapper, which would silently downgrade authorization to
  // authenticated-only — keep the wrapper so the real guards run per request.
  if (route.analysis.guards?.opaque) return false;

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
  route: RouteIR,
  modules: readonly ModuleInfo[],
  threshold: number,
): RouteIR => {
  const mod = modules[route.source.moduleIdx];
  const shouldInline = isInlineEligible(route, mod, threshold);

  return shouldInline === route.decisions.shouldInline
    ? route
    : { ...route, decisions: { ...route.decisions, shouldInline } };
};

export const detectInlineCandidates = (
  routes: readonly RouteIR[],
  modules: readonly ModuleInfo[],
  threshold: number,
): RouteIR[] => routes.map((r) => markInline(r, modules, threshold));

// ── Inline candidate resolution (moved out of codegen) ───────────

/** Minimal Bun.Transpiler surface the inliner uses. */
interface InlineTranspiler {
  transformSync(code: string): string;
}

/**
 * Shared TS→JS transpiler for handler-body inlining. Constructing
 * `Bun.Transpiler` is not free and the instance is stateless — one per process,
 * created lazily on first candidate (vitest workers may lack `Bun.Transpiler`,
 * which caches the `null` answer too).
 */
let sharedTranspiler: InlineTranspiler | null | undefined;
const getTranspiler = (): InlineTranspiler | null => {
  if (sharedTranspiler !== undefined) return sharedTranspiler;
  const bun = (
    globalThis as {
      Bun?: { Transpiler?: new (opts: { loader: string }) => InlineTranspiler };
    }
  ).Bun;
  sharedTranspiler = bun?.Transpiler ? new bun.Transpiler({ loader: "ts" }) : null;
  return sharedTranspiler;
};

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
  const t = getTranspiler();

  if (t) {
    try {
      // Wrap so top-level `return` / `await` are legal, then extract the inner
      // body from the transpiled (type-erased) function.
      const wrapped = t.transformSync(
        `${isAsync ? "async " : ""}function __ignexInline() { ${body} }`,
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
  route: RouteIR,
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
  routes: readonly RouteIR[],
  modules: readonly ModuleInfo[],
  opts: CompilerOptions,
): RouteIR[] =>
  routes.map((route) => {
    const inline = resolveInlineCandidate(route, modules[route.source.moduleIdx], opts);
    if (!inline) return route;
    return { ...route, decisions: { ...route.decisions, inlineCandidate: inline } };
  });

/**
 * Apply an opt-in global inlining budget, prioritized by route hotness.
 * Routes with the highest `hotnessScore` are inlined first; once the
 * cumulative body budget is exhausted, the remaining candidates are
 * de-inlined (their handlers are imported instead). No-op when
 * `maxTotalInlineBytes` is unset — every eligible route is inlined, as before.
 */
export const applyInlineBudget = (routes: readonly RouteIR[], opts: CompilerOptions): RouteIR[] => {
  const budget = opts.maxTotalInlineBytes;
  if (!budget || budget <= 0) return [...routes];

  const candidates = routes
    .map((route, index) => ({ route, index }))
    .filter((candidate) => candidate.route.decisions.inlineCandidate);

  // Hot-first; Array.sort is stable, so equal scores keep route order.
  candidates.sort((a, b) => b.route.analysis.hotnessScore - a.route.analysis.hotnessScore);

  let used = 0;
  const kept = new Set<number>();
  for (const { route, index } of candidates) {
    const size = route.decisions.inlineCandidate?.body.length ?? 0;
    if (used + size > budget) break;
    used += size;
    kept.add(index);
  }

  return routes.map((route, index) => {
    if (kept.has(index) || !route.decisions.inlineCandidate) return route;
    // De-inline: drop the inline flag and the candidate, keep the rest.
    const { shouldInline: _inline, inlineCandidate: _candidate, ...rest } = route.decisions;
    return { ...route, decisions: { ...rest, shouldInline: false } };
  });
};

// ── Constant-response deduplication ──────────────────────────────

export const hasConstantResponse = (route: RouteIR): boolean =>
  route.analysis.isConstantResponse && !!route.analysis.constantResponse;

export const groupByConstantResponse = (routes: readonly RouteIR[]): Map<string, RouteIR[]> => {
  const groups = new Map<string, RouteIR[]>();

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

export const buildDedupMap = (groups: Map<string, RouteIR[]>): Map<string, string> => {
  const replacements = new Map<string, string>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // Leader = the hottest route (ties → earliest in the group), so the
    // retained handler is the one exercised most.
    const leader = [...group].sort((a, b) => b.analysis.hotnessScore - a.analysis.hotnessScore)[0];
    if (!leader) continue;

    for (const member of group) {
      if (member === leader) continue;
      replacements.set(member.codegen.handlerRef, leader.codegen.handlerRef);
    }
  }

  return replacements;
};

export const applyDedup = (route: RouteIR, dedupMap: Map<string, string>): RouteIR => {
  const dedupGroup = dedupMap.get(route.codegen.handlerRef);
  return dedupGroup ? { ...route, decisions: { ...route.decisions, dedupGroup } } : route;
};

export const deduplicateRoutes = (routes: RouteIR[]): RouteIR[] => {
  const groups = groupByConstantResponse(routes);
  const dedupMap = buildDedupMap(groups);

  if (dedupMap.size === 0) return routes;

  return routes.map((r) => applyDedup(r, dedupMap));
};

export const countInlined = (routes: readonly RouteIR[]): number =>
  routes.filter((r) => r.decisions.shouldInline).length;

export const countDeduped = (routes: readonly RouteIR[]): number =>
  routes.filter((r) => r.decisions.dedupGroup).length;

export const runOptimization = (
  routes: readonly RouteIR[],
  modules: readonly ModuleInfo[],
  opts: CompilerOptions,
  ctx: CompilerContext,
): OptimizationResult => {
  // Timing is owned by the pipeline stage that calls this (single
  // `logger.time("optimization")` entry — the phase itself does not re-wrap).
  // Surface opaque guards once per file: the RBAC AOT optimization is
  // skipped and the runtime wrapper is preserved (never a silent downgrade).
  for (const route of routes) {
    if (!route.analysis.guards?.opaque) continue;
    const mod = modules[route.source.moduleIdx];
    ctx.diagnostics.warn({
      code: DiagnosticCodes.OpaqueGuards,
      message:
        `Route '${route.source.file}': withGuards argument is not statically evaluable — ` +
        "keeping the runtime wrapper so the real guards execute per request",
      file: mod?.path ?? route.source.file,
    });
  }

  const inlined = detectInlineCandidates(routes, modules, opts.inlineThreshold);

  const deduped = opts.enableHandlerDeduplication ? deduplicateRoutes(inlined) : inlined;

  // Resolve + transpile inline candidates up-front so codegen only reads
  // `decisions.inlineCandidate` (no re-derivation, no re-transpile).
  const resolved = computeInlineCandidates(deduped, modules, opts);
  // Hot-first global inlining budget (opt-in; no-op by default).
  const finalized = applyInlineBudget(resolved, opts);

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
};
