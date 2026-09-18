/**
 * @fileoverview Aborted-request short-circuit helper.
 *
 * A client that has already disconnected cannot receive a response, so running
 * hooks or the route handler for it is pure waste. Both the interpreted
 * lifecycle (`lifecycle/run.ts`) and the AOT-generated route core fn check
 * `req.signal.aborted` up front and return {@link abortedResponse} instead.
 * Living in one place keeps the two paths from drifting on the response shape.
 */

/**
 * The response returned when a request was ALREADY aborted before the pipeline
 * started.
 *
 * Matches the interpreted lifecycle and Elysia: an empty `200`. Aborts that
 * happen DURING handling remain observable to app code through
 * `ctx.req.signal`, so a handler can still cancel its own work — this helper is
 * only for the pre-aborted case where no work should begin.
 *
 * Callers on the hot path may hoist the result into a module constant (the
 * generated server does: `const __abortedResponse = abortedResponse()`), since
 * a bodyless `Response` is immutable from the framework's perspective and can
 * be served to any number of already-gone clients.
 *
 * @returns An empty `Response` with status 200.
 */
export const abortedResponse = (): Response => new Response(null, { status: 200 });
