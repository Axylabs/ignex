import { get } from "@ignex/core/http";

/** GET /users/:id — dynamic param echo. */
export default get(async (ctx) => ctx.json({ id: ctx.params.id }));
