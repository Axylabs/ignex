import type { IgnexContext } from "@ignex/core";

/**
 * Reads only `json`, so nothing in the handler forces the full context — the
 * route is exactly the shape the plugin layer must be able to serve.
 */
export default (ctx: IgnexContext) => ctx.json({ ok: true });
