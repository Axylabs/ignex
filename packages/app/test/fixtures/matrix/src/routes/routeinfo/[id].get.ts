import { get } from "@flux/core/http";

/** GET /routeinfo/:id — echoes the matched route pattern (ctx.route) + param. */
export default get(async (ctx) => ctx.json({ route: ctx.route, id: ctx.params.id }));
