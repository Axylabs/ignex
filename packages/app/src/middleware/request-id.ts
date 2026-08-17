import { type IgnexPlugin, mutateHeaders } from "@ignex/core";

/**
 * Global middleware example — a custom `IgnexPlugin`.
 *
 * Plugins run on EVERY request in onion order around the handler:
 *   onRequest  → before the handler
 *   onResponse → after the handler (reverse registration order)
 *   onError    → when the handler throws
 *
 * This one stamps a per-request `x-request-id` header and echoes it back.
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
  },
});
