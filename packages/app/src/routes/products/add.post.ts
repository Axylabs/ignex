import { post } from "@flux/core/http";

export default post(async (ctx) => {
  const body = await ctx.body.json<{ name?: string }>();

  return ctx.json({
    created: true,
    body,
  });
});
