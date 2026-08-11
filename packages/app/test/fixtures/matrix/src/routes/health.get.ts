import { get } from "@flux/core/http";

/** GET /health — liveness probe used by the boot harness. */
export default get(async (ctx) => ctx.json({ status: "ok" }));
