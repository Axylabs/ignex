import { post } from "@flux/core/http";

/** POST /form — echoes parsed application/x-www-form-urlencoded fields. */
export default post(async (ctx) => ctx.json({ fields: await ctx.body.form() }));
