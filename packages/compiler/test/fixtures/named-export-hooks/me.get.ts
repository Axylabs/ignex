// Named-export route with a RUNTIME before chain (not statically foldable).
// Regression: the compiler used to emit the chain only for default exports,
// so named-export guards silently never ran in the compiled server.
import { get } from "@ignex/core/http";
import { requireAuth } from "../../lib/guards";

// Deliberate trap: an exported helper that shapes like a handler. It must not
// win the handler selection (or stop guard extraction) just by appearing first.
export const helper = (value: number): number => value * 2;

export const httpGet = get((ctx) => ctx.json({ ok: helper(1) > 0 }), {
  before: [requireAuth()],
});
