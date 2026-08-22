/**
 * @fileoverview Codegen: per-route emission decisions (constant hoisting,
 * cache config) — pure IR → emitted-config mappings consulted while emitting
 * routes.
 *
 * Inline eligibility + candidate transpilation moved to the optimization
 * phase (`../optimization.ts`); codegen only reads `route.decisions`.
 */

import type { RouteIR } from "../../types";
import type { CodegenConfig } from "./config";

/** `HttpResponseCache` construction options (route `cache` config → options). */
export interface CacheOptions {
  ttlMs?: number;
  staleTtlMs?: number;
  vary?: string[];
}

/**
 * When the route's body is a compile-time constant, return the JSON to hoist
 * (or `null` to fall through to the normal path). Hoisting to a frozen
 * Response bypasses the whole lifecycle (plugins, hooks, ctx.set, error
 * handling) — only allowed when we can prove there is nothing to bypass.
 */
export const tryNormalizeConstant = (route: RouteIR, hasGlobalHooks: boolean): string | null => {
  if (!route.analysis.isConstantResponse || !route.analysis.constantResponse) return null;
  if (hasGlobalHooks) return null;
  if (route.analysis.hooks.length > 0) return null;
  // RBAC guards MUST run — never hoist a guarded route to a frozen body.
  if (route.analysis.guards) return null;
  // Route-local before/after chains (module `config` or a wrapper-attached
  // `handler.config`) would be bypassed by a frozen body — never hoist.
  if (route.analysis.configExport) return null;
  if (route.analysis.wrappedHandler) return null;
  if (route.analysis.localHooks) return null;
  if (route.analysis.hasValidation) return null;

  if (route.decisions.validators && Object.keys(route.decisions.validators).length > 0) {
    return null;
  }

  // `constantResponse` was produced by a JSON.stringify round-trip during
  // analysis, so it is already valid JSON — no re-parse required.
  return route.analysis.constantResponse;
};

/** Route `cache` config → {@link CacheOptions} (or `undefined`). */
export const getCacheConfig = (route: RouteIR, cfg: CodegenConfig): CacheOptions | undefined => {
  if (!cfg.routeCache) return undefined;
  if (route.source.method !== "GET" && route.source.method !== "HEAD") return undefined;

  const cache = route.analysis.cache;
  if (!cache) return undefined;

  const out: CacheOptions = {};

  if (typeof cache.maxAge === "number") {
    out.ttlMs = cache.maxAge * 1000;
  }

  if (typeof cache.swr === "number") {
    out.staleTtlMs = cache.swr * 1000;
  }

  if (Array.isArray(cache.vary)) {
    out.vary = [...cache.vary];
  }

  return Object.keys(out).length > 0 ? out : undefined;
};
