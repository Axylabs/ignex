import { continueHook, type HookFn } from "@ignex/core";

/**
 * Global lifecycle hook examples — `HookFn`s registered on the `beforeHandle`
 * stage in `src/app.config.ts`:
 *
 *   export const lifecycle = {
 *     beforeHandle: [logRequests(), markResponse()]
 *   };
 *
 * `beforeHandle` runs before the handler on every request. Return
 * `continueHook(ctx)` to proceed or `haltHook(response)` to short-circuit.
 *
 * To contribute to the RESPONSE without halting the chain, set headers on
 * `ctx.set` (the outgoing channel applied by the runtime at the end of the
 * request) — see `markResponse` below.
 */
export const logRequests = (): HookFn => {
  return (ctx) => {
    ctx.setState("requestStartedAt", Date.now());
    return continueHook(ctx);
  };
};

export const markResponse = (): HookFn => {
  return (ctx) => {
    ctx.set.headers["x-ignex-middleware"] = "true";
    return continueHook(ctx);
  };
};
