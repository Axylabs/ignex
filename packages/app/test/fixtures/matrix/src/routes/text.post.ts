import { post } from "@ignus/core/http";

/** POST /text — echoes the raw text body. */
export default post(async (ctx) => ctx.json({ text: await ctx.body.text() }));
