import { get } from "@ignex/core/http";

/** GET /ratelimit — intentionally rate-limited (max 5 requests / minute). */
export default get(async (ctx) => ctx.json({ ok: true }));
