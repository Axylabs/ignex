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
  /**
   * Fully-synchronous route (compact AND a statically-resolved non-`async`
   * handler): emit a NON-async core fn with no `await` on the handler call —
   * zero per-request Promise + microtask (Elysia's JIT sync path). Safe
   * because `compact` guarantees no async validation/hook stages and the
   * handler was statically resolved (an unresolvable handler forces
   * FULL_USAGE → `needsFull`, never compact).
   */
  readonly sync: boolean;
  /** Async resume fn name (non-async needsFull path); "" for other routes. */
  readonly resumeName: string;
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
    sync,
    serializersVar,
    routeHookVar,
    serviceName,
    routeReply,
  } = input;

  // Non-async needsFull core fn for statically-sync handlers (no validation,
  // sync handler — `generate.ts` only selects this path when the pre has no
  // `await`). The hot path runs WITHOUT any Promise/microtask; the async
  // resume below only fires when a hook actually returns a Promise (never for
  // all-sync apps), so it is a cold, correctness-only path.
  if (needsFull && sync) {
    return assembleNeedsFullSyncCoreFn(input);
  }

  return `${sync ? "" : "async "}function ${coreName}(req, params, server) {
  let ctx;
  try {
    ${pre.join("\n")}
    ${
      needsFull
        ? `
    if (__hasBeforeHandle) {
      const __r = runHooks(__lc.beforeHandle, ctx);
      const gBefore = __r instanceof Promise ? await __r : __r;
      ctx = gBefore.ctx ?? ctx;
      if (gBefore.response) return __applySet(gBefore.response, ctx.set);
    }
    ${
      // Only routes that register per-route hooks get the route-hook stage.
      // No-hook routes previously emitted `if ([].length > 0)` — allocating an
      // empty array on every request — so the stage is omitted entirely.
      hasRouteHooks
        ? `if (${routeHookVar}.length > 0) {
      const __r = runHooks(${routeHookVar}, ctx);
      const rBefore = __r instanceof Promise ? await __r : __r;
      ctx = rBefore.ctx ?? ctx;
      if (rBefore.response) return __applySet(rBefore.response, ctx.set);
    }
`
        : ""
    }
    `
        : ""
    }
    ${
      sync
        ? `const result = ${callExpr};`
        : `const __result0 = ${callExpr};
    const result = __result0 instanceof Promise ? await __result0 : __result0;`
    }
    let response = __finalize(result, ${needsFull ? "ctx" : "{ set: __set }"}, ${serializersVar}, ${routeReply});
    ${
      needsFull
        ? `
    if (__hasAfterHandle) {
      const __r1 = runHooks(__lc.afterHandle, ctx, response);
      const after = __r1 instanceof Promise ? await __r1 : __r1;
      ctx = after.ctx ?? ctx;
      response = after.response ?? response;
    }
    if (__hasMapResponse) {
      const __r2 = runHooks(__lc.mapResponse, ctx, response);
      const mapped = __r2 instanceof Promise ? await __r2 : __r2;
      ctx = mapped.ctx ?? ctx;
      response = mapped.response ?? response;
    }
    // Observe-only post-handler stages: a throwing afterResponse/trace hook
    // must not corrupt an already-finalized response (matches interpreted),
    // but the error is surfaced so broken hooks are debuggable. Empty stages
    // are folded away (boot-time constants — no Promise + microtask per stage).
    if (__hasAfterResponse) {
      try { const __r = runHooks(__lc.afterResponse, ctx, response); if (__r instanceof Promise) await __r; } catch (__err) { console.error("[ignex] afterResponse hook error:", __err); }
    }
    if (__hasTrace) {
      try { const __r = runHooks(__lc.trace, ctx, response); if (__r instanceof Promise) await __r; } catch (__err) { console.error("[ignex] trace hook error:", __err); }
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

/**
 * Non-async needsFull core fn for statically-sync handlers: the whole pipeline
 * (pre-parse → before-handle → handler → after-handle → … → applySet) runs
 * synchronously with ZERO Promise/microtask. Each stage branches on
 * `instanceof Promise`; on a Promise it delegates the remainder to the async
 * resume fn (a cold path — it only fires when a hook is async, which never
 * happens for all-sync apps). `pre` already contains the createContext + the
 * pre-parse stage in delegation form (see `buildFullContextPrelude`).
 */
const assembleNeedsFullSyncCoreFn = (input: CoreFnInput): string => {
  const {
    coreName,
    pre,
    callExpr,
    hasRouteHooks,
    serializersVar,
    routeHookVar,
    serviceName,
    routeReply,
    resumeName,
  } = input;

  const routeHooksStage = hasRouteHooks
    ? `if (${routeHookVar}.length > 0) {
      const __r = runHooks(${routeHookVar}, ctx);
      if (__r instanceof Promise) return ${resumeName}(ctx, undefined, 3, __r);
      const rBefore = __r;
      ctx = rBefore.ctx ?? ctx;
      if (rBefore.response) return __applySet(rBefore.response, ctx.set, __TRACE ? ctx.requestId : undefined);
    }
`
    : "";

  const syncBody = `function ${coreName}(req, params, server) {
  let ctx;
  try {
    ${pre.join("\n")}
    if (__hasBeforeHandle) {
      const __r = runHooks(__lc.beforeHandle, ctx);
      if (__r instanceof Promise) return ${resumeName}(ctx, undefined, 2, __r);
      const gBefore = __r;
      ctx = gBefore.ctx ?? ctx;
      if (gBefore.response) return __applySet(gBefore.response, ctx.set, __TRACE ? ctx.requestId : undefined);
    }
    ${routeHooksStage}
    const __result0 = ${callExpr};
    if (__result0 instanceof Promise) return ${resumeName}(ctx, undefined, 4, __result0);
    let response = __finalize(__result0, ctx, ${serializersVar}, ${routeReply});
    if (__hasAfterHandle) {
      const __r1 = runHooks(__lc.afterHandle, ctx, response);
      if (__r1 instanceof Promise) return ${resumeName}(ctx, response, 5, __r1);
      const after = __r1;
      ctx = after.ctx ?? ctx;
      response = after.response ?? response;
    }
    if (__hasMapResponse) {
      const __r2 = runHooks(__lc.mapResponse, ctx, response);
      if (__r2 instanceof Promise) return ${resumeName}(ctx, response, 6, __r2);
      const mapped = __r2;
      ctx = mapped.ctx ?? ctx;
      response = mapped.response ?? response;
    }
    if (__hasAfterResponse) {
      const __r = runHooks(__lc.afterResponse, ctx, response);
      if (__r instanceof Promise) return ${resumeName}(ctx, response, 7, __r);
    }
    if (__hasTrace) {
      const __r = runHooks(__lc.trace, ctx, response);
      if (__r instanceof Promise) return ${resumeName}(ctx, response, 8, __r);
    }
    if (__ACCESS_LOG) {
      const __ms = (performance.now() - ctx.startTime).toFixed(2);
      console.log(JSON.stringify({ ts: new Date().toISOString(), service: ${JSON.stringify(serviceName)}, requestId: ctx.requestId, method: req.method, path: ctx.path, status: response.status, ms: Number(__ms) }));
    }
    return __applySet(response, ctx.set, __TRACE ? ctx.requestId : undefined);
  } catch (err) {
    return __handleError(err, ctx);
  }
}`;

  // Async resume: continues the pipeline from `stage` (1..8). `value` is the
  // Promise the sync core handed off at that stage (it only delegates when a
  // stage returns a Promise), so every `value` here is awaited. Stages <
  // `stage` ran in the sync core; stages > `stage` run here (awaited). Cold,
  // correctness-only path.
  const resumeBody = `async function ${resumeName}(ctx, response, stage, value) {
  try {
    if (stage === 1) {
      const __globalPre = await value;
      if (__globalPre.response) return __applySet(__globalPre.response, ctx.set, __TRACE ? ctx.requestId : undefined);
      ctx = __globalPre.ctx ?? ctx;
    }
    if (stage <= 2 && __hasBeforeHandle) {
      const __r = stage === 2 ? await value : await runHooks(__lc.beforeHandle, ctx);
      const gBefore = __r;
      ctx = gBefore.ctx ?? ctx;
      if (gBefore.response) return __applySet(gBefore.response, ctx.set, __TRACE ? ctx.requestId : undefined);
    }
    ${
      hasRouteHooks
        ? `if (stage <= 3 && ${routeHookVar}.length > 0) {
      const __r = stage === 3 ? await value : await runHooks(${routeHookVar}, ctx);
      const rBefore = __r;
      ctx = rBefore.ctx ?? ctx;
      if (rBefore.response) return __applySet(rBefore.response, ctx.set, __TRACE ? ctx.requestId : undefined);
    }
`
        : ""
    }
    if (stage <= 4) {
      const __result0 = stage === 4 ? await value : ${callExpr};
      response = __finalize(__result0, ctx, ${serializersVar}, ${routeReply});
    }
    if (stage <= 5 && __hasAfterHandle) {
      const __r1 = stage === 5 ? await value : await runHooks(__lc.afterHandle, ctx, response);
      const after = __r1;
      ctx = after.ctx ?? ctx;
      response = after.response ?? response;
    }
    if (stage <= 6 && __hasMapResponse) {
      const __r2 = stage === 6 ? await value : await runHooks(__lc.mapResponse, ctx, response);
      const mapped = __r2;
      ctx = mapped.ctx ?? ctx;
      response = mapped.response ?? response;
    }
    if (stage <= 7 && __hasAfterResponse) {
      await runHooks(__lc.afterResponse, ctx, response);
    }
    if (stage <= 8 && __hasTrace) {
      await runHooks(__lc.trace, ctx, response);
    }
    if (__ACCESS_LOG) {
      const __ms = (performance.now() - ctx.startTime).toFixed(2);
      console.log(JSON.stringify({ ts: new Date().toISOString(), service: ${JSON.stringify(serviceName)}, requestId: ctx.requestId, method: req.method, path: ctx.path, status: response.status, ms: Number(__ms) }));
    }
    return __applySet(response, ctx.set, __TRACE ? ctx.requestId : undefined);
  } catch (err) {
    return __handleError(err, ctx);
  }
}`;

  return `${syncBody}\n\n${resumeBody}`;
};
