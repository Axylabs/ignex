import { post } from "@ignex/core/http";
import { csrfGuard } from "../lib/csrf-guard.js";

/** POST /csrf-submit — CSRF-protected mutation; echoes the JSON body. */
export default post(async (ctx) => ctx.json({ echoed: await ctx.body.json() }), {
  before: [csrfGuard],
});
