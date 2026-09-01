/**
 * @fileoverview Codegen: per-route handler emission (`generateRouteCode`).
 *
 * Emits each route's core function (constant-hoisted, full-context, or
 * usage-specialized) plus its cache wrapper. The emission is composed from
 * focused builders (context, validate, reply, handler, cache) that read/write
 * the shared `CodegenState`.
 */

import type { CompilerOptions, RouteIR } from "../../../types";
import { getCacheConfig, tryNormalizeConstant } from "../decisions";
import { heatCountStmt } from "../heat";
import {
  coreHandlerName,
  ctxOptsVar,
  guardHookEmissions,
  handlerImportName,
  methodHandlerName,
  routeReplyFn,
  wildcardNames,
} from "../identifiers";
import type { CodegenState } from "../state";
import { emitCacheWrapper } from "./cache";
import { emitConstantRoute } from "./constant";
import { buildFullContextPrelude, buildSpecializedContext } from "./context";
import { assembleCoreFn } from "./handler";
import { emitNativeRouteVar, emitNativeValidationPrelude, nativeRouteEligible } from "./native";
import {
  buildRouteAfterVar,
  buildRouteBeforeVar,
  buildSerializersVar,
  routeHasLocalHooks,
} from "./reply";
import { emitWsRoute } from "./ws";

/**
 * Emit the code for a single route. Deduplicated (non-leader) routes reuse the
 * leader's handler and emit nothing here.
 */
export const generateRouteCode = (
  state: CodegenState,
  route: RouteIR,
  opts: CompilerOptions,
): void => {
  const { cfg, appConfigHasHooks, usedCore, functions } = state;

  // Deduplicated (non-leader) routes reuse the leader's handler; only the
  // leader emits it.
  if (route.decisions.dedupGroup) return;

  if (route.source.method === "WS") {
    emitWsRoute(state, route);
    return;
  }

  // Only an app config that actually registers plugins/lifecycle hooks must
  // force the full-context path; a server-only config carries no lifecycle.
  const hasGlobalLifecycle = appConfigHasHooks;
  const constantJson = tryNormalizeConstant(route, hasGlobalLifecycle);

  // Constant responses are hoisted to zero-cost frozen bodies — unless the
  // app has a lifecycle/plugins (hooks would be bypassed), trace headers or
  // access logging are enabled (need a per-request context), or constant
  // hoisting is disabled by the optimization level. In those cases the route
  // falls through to the normal (full or specialized) path.
  if (
    cfg.hoistConstants &&
    constantJson !== null &&
    !cfg.enableTraceHeaders &&
    !cfg.enableAccessLog
  ) {
    emitConstantRoute(state, route, constantJson);
    return;
  }

  const hasHooks = routeHasLocalHooks(route);

  // Emit the RBAC guard hooks (`hasRole(...)` / `can(...)` / `canAll(...)` /
  // `requireAuthenticated`) as module-level consts referenced from the route's
  // pre-execution hook array. The referenced core symbols join `usedCore` so
  // the entry's import carries them (the bundler prunes any that end up
  // unused).
  for (const g of guardHookEmissions(route)) {
    state.header.push(`const ${g.ident} = ${g.expr};`);
    const openParen = g.expr.indexOf("(");
    usedCore.add(openParen < 0 ? g.expr : g.expr.slice(0, openParen));
  }

  // Usage-driven context specialization. A full context is required when the
  // route needs lifecycle/hooks, validation, cookies, forwarding, or file
  // handling, or when context specialization is disabled. This is driven by
  // the AST-derived ContextUsage, not a substring scan of the source.
  const needsFull =
    !cfg.specializeContext ||
    cfg.enableTraceHeaders ||
    cfg.enableAccessLog ||
    hasHooks ||
    hasGlobalLifecycle ||
    route.analysis.hasValidation ||
    route.analysis.usage.cookie ||
    route.analysis.usage.set ||
    route.analysis.usage.proxy ||
    route.analysis.usage.forward ||
    route.analysis.usage.cache ||
    route.analysis.usage.loader ||
    route.analysis.usage.sendFile ||
    route.analysis.usage.file ||
    route.analysis.usage.debug;

  const cacheConfig = getCacheConfig(route, cfg);
  const coreName = coreHandlerName(route, !!cacheConfig);

  // Compact no-set mode: when the specialized context never touches
  // `ctx.set`/`ctx.cookie` (no response mutations accumulate), the finalized
  // Response needs no `__applySet` pass — return it directly.
  // (Elysia's `responseMode: 'compact'`.) Only reachable on the specialized
  // path (`needsFull` already forces full context for set/cookie usage).
  const compact = !needsFull && !route.analysis.usage.set && !route.analysis.usage.cookie;

  // Fully-synchronous route fast path: a statically-known sync handler → non-
  // async core fn (zero per-request Promise/microtask — Elysia's JIT sync
  // path). For compact routes the handler is called directly. For needsFull
  // routes the sync path additionally requires NO validation (the native/JS
  // validation prelude awaits body reads) and a statically-resolved handler
  // (unresolvable → FULL_USAGE → needsFull), so isAsync is exact.
  const routeIsSync = !route.analysis.isAsync && !(needsFull && route.analysis.hasValidation);
  // Async resume fn name for the non-async needsFull path (cold, correctness-
  // only — fires only when a hook returns a Promise, never for all-sync apps).
  const resumeName = needsFull && routeIsSync ? `${coreName}__resume` : "";

  // Record the table-bound wrapper variant for pass 2. Wildcard routes (and
  // anything that returned earlier, e.g. WS) stay unrecorded → the generic
  // runtime-checked `__wrap` — exact prior behavior. `needsFull && sync`
  // routes use the async static wrapper: their non-async core fn can still
  // return a Promise via the cold hook-resume continuation.
  if (wildcardNames(route.source.path).length === 0) {
    state.wrapVariants.set(
      methodHandlerName(route),
      routeIsSync && !cacheConfig && !needsFull ? "static-sync" : "static",
    );
  }

  const pre: string[] = [];
  let callExpr = "";

  // Dev heat capture (`heatCapture`): count this request against the route's
  // static "METHOD path" identity as the first statement of the core fn.
  const heat = heatCountStmt(route, cfg.heatCapture);
  if (heat) pre.push(heat);

  if (needsFull) {
    // Hoist the per-route context options to a frozen module const. The old
    // `{ body: BODY_LIMITS, route }` object literal was re-allocated on EVERY
    // request; `IgnexContextImpl` only reads opts, never mutates, so sharing a
    // frozen instance is safe (removes one allocation + a hidden class change
    // per request on the full-context path).
    state.header.push(
      `const ${ctxOptsVar(route)} = Object.freeze({ body: BODY_LIMITS, route: ${JSON.stringify(route.source.path)} });`,
    );
    // Full context: create the context, run the pre-parse lifecycle, then the
    // per-part validation block (native-first prelude when the route is
    // eligible and `nativeRoutes` is on — the addon pre-bakes the exact
    // query/cookie pipeline; otherwise the plain JS prelude).
    pre.push(...buildFullContextPrelude(route, routeIsSync, resumeName));
    if (nativeRouteEligible(route, opts)) {
      emitNativeRouteVar(state, route, opts);
    }
    pre.push(...emitNativeValidationPrelude(route, opts, usedCore));

    // Call the handler directly. `__lc.afterHandle` (user hooks + plugin
    // `onResponse`) must NOT run on the raw handler result — plugin hooks
    // expect a `Response`, and running them on a plain object would break
    // (e.g. reading `response.status`). They run once, on the finalized
    // response, in the outer `runHooks(__lc.afterHandle ?? __lc.onResponse, ...)`
    // call below.
    callExpr = `${handlerImportName(route)}(ctx)`;
  } else {
    const specialized = buildSpecializedContext(route, usedCore);
    pre.push(...specialized.pre);
    callExpr = specialized.callExpr;
  }

  const serializersVar = buildSerializersVar(route);
  const routeHookVar = buildRouteBeforeVar(route);
  const routeAfterVar = buildRouteAfterVar(route);

  const coreFn = assembleCoreFn({
    coreName,
    pre,
    callExpr,
    needsFull,
    compact,
    hasRouteHooks: hasHooks,
    hasRouteAfter:
      route.analysis.configExport || route.analysis.wrappedHandler || route.analysis.localHooks,
    sync: routeIsSync,
    resumeName,
    serializersVar,
    routeHookVar,
    routeAfterVar,
    serviceName: cfg.serviceName,
    routeReply: routeReplyFn(route),
  });

  // Emit the core handler exactly ONCE. Cached routes additionally emit the
  // cache wrapper (`methodHandlerName` delegates to `core_<ref>`); non-cached
  // routes name the core handler `methodHandlerName` directly (the routes
  // table binds it). Previously the core fn was pushed twice for non-cached
  // routes, doubling the generated handler (dead bytes; second def wins).
  if (cacheConfig) {
    functions.push(coreFn);
    emitCacheWrapper(state, route, cacheConfig, coreName);
  } else {
    functions.push(coreFn);
  }
};
