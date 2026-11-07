import { get } from "@ignex/core/http";
import { csrfGuard } from "../lib/csrf-guard.js";

/** GET /csrf — mints the csrf-token cookie (the guard runs on every method). */
export default get(async (ctx) => ctx.json({ csrf: "ready" }), { before: [csrfGuard] });
