/** Templates for the `middleware` (global hooks) scaffold feature. */

export function middlewareIndexTemplate(): string {
  return `import { requestId } from "./request-id.js";

// Custom global plugins (IgnexPlugin) wired into \`src/app.config.ts\` via the
// \`plugins\` array. Add your own middleware here.
export const middleware = [
  requestId()
];
`;
}

export function middlewareRequestIdTemplate(): string {
  return `import { mutateHeaders, type IgnexPlugin } from "@ignex/core";

/**
 * Global middleware example — a custom \`IgnexPlugin\`.
 *
 * Plugins run on EVERY request in onion order around the handler:
 *   onRequest  → before the handler
 *   onResponse → after the handler (reverse registration order)
 *   onError    → when the handler throws
 *
 * This one stamps a per-request \`x-request-id\` header and echoes it back.
 */
export const requestId = (): IgnexPlugin => ({
  name: "request-id",
  onRequest(ctx) {
    ctx.setState("requestId", crypto.randomUUID());
    return ctx;
  },
  onResponse(ctx, response) {
    const id = ctx.getState<string>("requestId");
    if (!id) return response;
    return mutateHeaders(response, (headers) => headers.set("x-request-id", id));
  }
});
`;
}

export function middlewareLogRequestsTemplate(): string {
  return `import { continueHook, type HookFn } from "@ignex/core";

/**
 * Global lifecycle hook examples — \`HookFn\`s registered on the
 * \`beforeHandle\` stage in \`src/app.config.ts\`:
 *
 *   export const lifecycle = {
 *     beforeHandle: [logRequests(), markResponse()]
 *   };
 *
 * \`beforeHandle\` runs before the handler on every request. Return
 * \`continueHook(ctx)\` to proceed or \`haltHook(response)\` to short-circuit.
 *
 * To contribute to the RESPONSE without halting the chain, set headers on
 * \`ctx.set\` (the outgoing channel applied by the runtime at the end of the
 * request) — see \`markResponse\` below.
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
`;
}

export function middlewareReadmeTemplate(): string {
  return `# Middleware (global hooks)

Ignex runs code on every request in two ways:

1. **Plugins** (\`IgnexPlugin\`) — \`onRequest\` / \`onResponse\` / \`onError\`
   run in onion order around the handler. Wire them into the \`plugins\` array
   in \`src/app.config.ts\` (see \`index.ts\` + \`request-id.ts\` here).
2. **Lifecycle stage hooks** (\`HookFn\`) — registered on a named stage
   (\`start\`, \`request\`, \`parse\`, \`transform\`, \`beforeHandle\`,
   \`afterHandle\`, \`mapResponse\`, \`afterResponse\`, \`trace\`, \`error\`) via
   the \`lifecycle\` export in \`src/app.config.ts\` (see \`log-requests.ts\`).

A hook returns \`continueHook(ctx)\` to proceed or \`haltHook(response)\` to
short-circuit (or replace) a response.

For **per-route** hooks, scaffold a named hook with \`ignex hook <name>\` and
reference it from a route via \`export const config = { hooks: ["<name>"] }\`.
`;
}
