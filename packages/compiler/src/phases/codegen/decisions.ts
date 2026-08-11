/**
 * @fileoverview Codegen: per-route decisions (constant hoisting, cache config,
 * inline eligibility) — pure functions consulted while emitting routes.
 */

import type { CompilerOptions, ModuleInfo, RouteDef } from "../../types";
import { handlerBodyReferencesImports, isPlainJavaScriptBody, parseModule } from "../../utils/ast";
import type { CodegenConfig } from "./config";

/**
 * When the route's body is a compile-time constant, return the JSON to hoist
 * (or `null` to fall through to the normal path). Hoisting to a frozen
 * Response bypasses the whole lifecycle (plugins, hooks, ctx.set, error
 * handling) — only allowed when we can prove there is nothing to bypass.
 */
export const tryNormalizeConstant = (route: RouteDef, hasGlobalHooks: boolean): string | null => {
  if (!route.isConstantResponse || !route.constantResponse) return null;
  if (hasGlobalHooks) return null;
  if (route.hooks.length > 0) return null;
  if (route.hasValidation) return null;

  if (route.validators && Object.keys(route.validators).length > 0) {
    return null;
  }

  // `constantResponse` was produced by a JSON.stringify round-trip during
  // analysis, so it is already valid JSON — no re-parse required.
  return route.constantResponse;
};

/** Route `cache` config → `HttpResponseCache` options (or `undefined`). */
export const getCacheConfig = (
  route: RouteDef,
  cfg: CodegenConfig,
):
  | {
      ttlMs?: number;
      staleTtlMs?: number;
      vary?: string[];
    }
  | undefined => {
  if (!cfg.routeCache) return undefined;
  if (route.method !== "GET" && route.method !== "HEAD") return undefined;

  const cache = route.cache;
  if (!cache) return undefined;

  const out: {
    ttlMs?: number;
    staleTtlMs?: number;
    vary?: string[];
  } = {};

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
 * A handler can be inlined (instead of imported) when its module is fully
 * self-contained: no imports the body references, no other top-level symbols,
 * a simple identifier parameter, a body under `maxInlineBytes`, and marked
 * eligible by the optimization phase (`shouldInline`). The body is transpiled
 * to plain JS so TS-only syntax never leaks into the generated server.
 */
export const getInlineCandidate = (
  route: RouteDef,
  mod: ModuleInfo | undefined,
  opts: CompilerOptions,
): { body: string; isAsync: boolean; param: string } | null => {
  if (!route.shouldInline) return null;
  if (!mod) return null;
  // Imports referenced by the handler body would be dropped when inlined;
  // imports that only feed the wrapper call / type-only imports are fine.
  if (handlerBodyReferencesImports(mod)) return null;

  // The named-export handler's own symbol is fine; any OTHER top-level symbol
  // means the module is not fully self-contained.
  const selfName = route.handlerExportName;
  const otherSymbols = selfName ? mod.symbols.filter((s) => s.name !== selfName) : mod.symbols;
  if (otherSymbols.length > 0) return null;

  const parsed = parseModule(mod.content);
  const handler = parsed.handler;
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
