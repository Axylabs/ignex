import { get } from "@ignex/core/http";

/** GET /static — a plain static route. */
export default get(async (ctx) => ctx.json({ static: true }));
