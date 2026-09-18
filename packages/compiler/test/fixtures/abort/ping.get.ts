// AOT abort fixture: a route with a real (non-hoisted) core fn that records
// its invocation on `globalThis`, so the test can prove a pre-aborted request
// short-circuits BEFORE the handler.
export default (ctx: { json: (value: unknown) => Response }) => {
  (globalThis as { __abortHandlerCalled?: boolean }).__abortHandlerCalled = true;
  return ctx.json({ ok: true });
};
