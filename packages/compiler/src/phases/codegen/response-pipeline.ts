/**
 * @fileoverview Codegen: non-success response pipeline.
 *
 * Every response that does NOT come from a route's success path (a thrown
 * error, a guard/plugin halt, a pre-stage short-circuit) flows through
 * {@link RESPONSE_PIPELINE_HELPERS}: the error stage, then the response
 * pipeline (`afterHandle` -> `mapResponse` -> observe) so plugins decorate it
 * (CORS echo, compression, security) and `ctx.set` mutations are delivered.
 *
 * Kept separate from `helpers.ts` to stay under the maintainability size cap;
 * the entries are merged into `HELPER_SOURCES` (emitted unconditionally, DCE'd
 * by the linker when unreferenced).
 */

/** Helpers emitted for error + halt responses. */
export const RESPONSE_PIPELINE_HELPERS: Record<string, string> = {
  __finishResponse: `async function __finishResponse(response, ctx, postRan = false) {
  // Shared tail for EVERY response that did not come from the success path
  // (thrown errors, guard/plugin halts): run the response pipeline so the
  // plugins that decorate responses (CORS echo, compression, security) and
  // the user's afterHandle/mapResponse hooks apply, then deliver \`ctx.set\`
  // mutations. A throwing hook must never replace the response with a 500.
  //
  // postRan is true when the error came FROM that pipeline: re-running a
  // throwing afterHandle/mapResponse would double its side effects.
  if (ctx && !postRan) {
    if (__hasAfterHandle) {
      try {
        const __r1 = __TRACE_DEBUG ? runTimed("afterHandle", "lifecycle", () => __runAfter(ctx, response)) : __runAfter(ctx, response);
        const __after = __r1 instanceof Promise ? await __r1 : __r1;
        ctx = __after.ctx ?? ctx;
        response = __after.response ?? response;
      } catch (__postErr) {
        console.error("[ignex] afterHandle hook threw on a non-success response:", __postErr);
      }
    }
    if (__hasMapResponse) {
      try {
        const __r2 = __TRACE_DEBUG ? runTimed("mapResponse", "lifecycle", () => runHooks(__lc.mapResponse, ctx, response)) : runHooks(__lc.mapResponse, ctx, response);
        const __mapped = __r2 instanceof Promise ? await __r2 : __r2;
        ctx = __mapped.ctx ?? ctx;
        response = __mapped.response ?? response;
      } catch (__postErr) {
        console.error("[ignex] mapResponse hook threw on a non-success response:", __postErr);
      }
    }
    if (__hasAfterResponse) {
      try { const __r3 = __TRACE_DEBUG ? runTimed("afterResponse", "lifecycle", () => runHooks(__lc.afterResponse, ctx, response)) : runHooks(__lc.afterResponse, ctx, response); if (__r3 instanceof Promise) await __r3; } catch (__obsErr) { console.error("[ignex] afterResponse hook error:", __obsErr); }
    }
    if (__hasTrace) {
      try { const __r4 = __TRACE_DEBUG ? runTimed("trace", "lifecycle", () => runHooks(__lc.trace, ctx, response)) : runHooks(__lc.trace, ctx, response); if (__r4 instanceof Promise) await __r4; } catch (__obsErr) { console.error("[ignex] trace hook error:", __obsErr); }
    }
    response = __applySet(response, ctx.set, __TRACE ? ctx.requestId : undefined);
  }
  return __DEFAULT_HEADERS ? __decorateWithDefaults(response) : response;
}`,
  __haltResponse: `function __haltResponse(response, ctx) {
  return __finishResponse(response, ctx);
}`,
  __handleError: `async function __handleError(err, ctx, postRan = false) {
  let response;
  try {
    const __r = __TRACE_DEBUG ? runTimed("error", "lifecycle", () => runHooks(__lc.error, ctx, err)) : runHooks(__lc.error, ctx, err);
    const r = __r instanceof Promise ? await __r : __r;
    if (r.response) {
      response = r.response;
      ctx = r.ctx ?? ctx;
    }
  } catch (__hookErr) {
    // Must not mask the original error — and must not be swallowed either.
    console.error("[ignex] error-stage hook threw:", __hookErr);
  }
  if (!response) response = errorToResponse(err, EXPOSE_ERRORS, ctx);
  return __finishResponse(response, ctx, postRan);
}`,
};
