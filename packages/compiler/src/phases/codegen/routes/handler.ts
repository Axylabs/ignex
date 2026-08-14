/**
 * @fileoverview Codegen: the per-route core handler assembly.
 *
 * `assembleCoreFn` renders the single route function that runs the prelude,
 * calls the handler, finalizes the response, and runs the post-handler
 * lifecycle stages. The emitted text is byte-stable — any change here shows
 * up in the codegen golden fixtures.
 */

export interface CoreFnInput {
  readonly coreName: string;
  readonly pre: readonly string[];
  readonly callExpr: string;
  readonly needsFull: boolean;
  /**
   * Compact (no-`set`) response mode: nothing in the request touches
   * `ctx.set`/`ctx.cookie`, so the finalized Response needs no `__applySet`
   * pass. The core fn returns it directly (Elysia's `responseMode: 'compact'`).
   */
  readonly compact: boolean;
  /** True when the route registers per-route hooks (emits the route-hook stage). */
  readonly hasRouteHooks: boolean;
  readonly serializersVar: string;
  readonly routeHookVar: string;
  readonly serviceName: string;
  readonly routeReply: string;
}

/** Render the full generated core handler for one route. */
export const assembleCoreFn = (input: CoreFnInput): string => {
  const {
    coreName,
    pre,
    callExpr,
    needsFull,
    compact,
    hasRouteHooks,
    serializersVar,
    routeHookVar,
    serviceName,
    routeReply,
  } = input;

  return `async function ${coreName}(req, params, server) {
  let ctx;
  try {
    ${pre.join("\n")}
    ${
      needsFull
        ? `
    if (__lc.beforeHandle && __lc.beforeHandle.length > 0) {
      const gBefore = await runHooks(__lc.beforeHandle, ctx);
      ctx = gBefore.ctx ?? ctx;
      if (gBefore.response) return __applySet(gBefore.response, ctx.set);
    }
    ${
      // Only routes that register per-route hooks get the route-hook stage.
      // No-hook routes previously emitted `if ([].length > 0)` — allocating an
      // empty array on every request — so the stage is omitted entirely.
      hasRouteHooks
        ? `if (${routeHookVar}.length > 0) {
      const rBefore = await runHooks(${routeHookVar}, ctx);
      ctx = rBefore.ctx ?? ctx;
      if (rBefore.response) return __applySet(rBefore.response, ctx.set);
    }
`
        : ""
    }
    `
        : ""
    }
    const result = await ${callExpr};
    let response = __finalize(result, ${needsFull ? "ctx" : "{ set: __set }"}, ${serializersVar}, ${routeReply});
    ${
      needsFull
        ? `
    if (__lc.afterHandle && __lc.afterHandle.length > 0) {
      const after = await runHooks(__lc.afterHandle, ctx, response);
      ctx = after.ctx ?? ctx;
      response = after.response ?? response;
    }
    if (__lc.mapResponse && __lc.mapResponse.length > 0) {
      const mapped = await runHooks(__lc.mapResponse, ctx, response);
      ctx = mapped.ctx ?? ctx;
      response = mapped.response ?? response;
    }
    // Observe-only post-handler stages: a throwing afterResponse/trace hook
    // must not corrupt an already-finalized response (matches interpreted),
    // but the error is surfaced so broken hooks are debuggable. Empty stages
    // are skipped entirely (no Promise + microtask per stage).
    if (__lc.afterResponse && __lc.afterResponse.length > 0) {
      try { await runHooks(__lc.afterResponse, ctx, response); } catch (__err) { console.error("[ignex] afterResponse hook error:", __err); }
    }
    if (__lc.trace && __lc.trace.length > 0) {
      try { await runHooks(__lc.trace, ctx, response); } catch (__err) { console.error("[ignex] trace hook error:", __err); }
    }
    if (__ACCESS_LOG) {
      const __ms = (performance.now() - ctx.startTime).toFixed(2);
      console.log(JSON.stringify({ ts: new Date().toISOString(), service: ${JSON.stringify(serviceName)}, requestId: ctx.requestId, method: req.method, path: ctx.path, status: response.status, ms: Number(__ms) }));
    }
    // __TRACE is a module constant, so when tracing is off this never
    // evaluates ctx.requestId (which would pay performance.now() + a counter
    // per request even though applySet ignores it without trace).
    return __applySet(response, ctx.set, __TRACE ? ctx.requestId : undefined);
    `
        : compact
          ? `return response;`
          : `return __applySet(response, __set);`
    }
  } catch (err) {
    return __handleError(err, ${needsFull ? "ctx" : "undefined"});
  }
}`;
};
