// Self-contained handler (inline-eligible shape) that declares a runtime
// before chain. Inlining would drop `handler.config.before`, so the compiler
// must keep the imported wrapper.
import { get } from "@ignex/core/http";

export const httpGet = get((ctx) => ctx.json({ ok: true }), {
  before: [(ctx) => ctx],
});
