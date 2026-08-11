import { post } from "@flux/core/http";
import { Type } from "@sinclair/typebox";

/** POST /validate-body — body schema (`name` required, `age` optional number). */
export default post(async (ctx) => ctx.json({ body: await ctx.body.json() }), {
  body: Type.Object({
    name: Type.String(),
    age: Type.Optional(Type.Number()),
  }),
});
