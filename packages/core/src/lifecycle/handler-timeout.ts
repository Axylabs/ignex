/**
 * @fileoverview Handler execution timeout — the per-handler wall-clock cap
 * the request path previously lacked. Bun's `idleTimeout` bounds INACTIVITY;
 * a handler awaiting a slow-drip upstream that keeps bytes flowing held the
 * connection (and the worker) indefinitely. The timeout races the HANDLER's
 * returned `Response` promise only: streaming responses (SSE, WS upgrades,
 * chunked downloads) return their `Response` immediately and are therefore
 * naturally exempt — the stream keeps its own lifecycle.
 *
 * Off by default (`handlerTimeoutMs: 0`): enabling it changes completion
 * semantics for legitimately slow handlers, so it is an explicit operator
 * decision. The underlying handler promise is NOT cancelled (JS cannot
 * cancel arbitrary work) — the client gets 503 while the work runs out its
 * clock; use `ctx.req.signal` in handlers for cooperative cancellation.
 */

/** Stable reason marker for the 503 envelope (see `x-ignex-reason`). */
export const HANDLER_TIMEOUT_REASON = "handler-timeout";

/** Stable error code surfaced in the JSON body. */
export const HANDLER_TIMEOUT_CODE = "IGN_HANDLER_TIMEOUT";

/** The 503 envelope a timed-out handler resolves to. */
export const handlerTimeoutResponse = (): Response =>
  Response.json(
    { error: "Handler timeout", code: HANDLER_TIMEOUT_CODE },
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "x-ignex-reason": HANDLER_TIMEOUT_REASON,
      },
    },
  );

/**
 * Race a handler invocation against `timeoutMs`. Values ≤ 0 / undefined
 * disable the guard (identity behavior — the common case). Returns the
 * handler's Response when it wins, or the 503 timeout envelope otherwise.
 */
export const withHandlerTimeout = <R extends Response>(
  handler: () => R | Promise<R>,
  timeoutMs: number | undefined,
): R | Promise<R> => {
  if (!timeoutMs || timeoutMs <= 0) return handler();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<R>((resolve) => {
    timer = setTimeout(() => resolve(handlerTimeoutResponse() as R), timeoutMs);
  });
  const work = Promise.resolve(handler()).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  return Promise.race([work, timeout]);
};
