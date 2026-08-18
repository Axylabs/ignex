import { post } from "@ignex/core/http";
import { Type } from "typebox";

/** POST /validate-body — body schema (`name` required, `age` optional number). */
export default post(async (ctx) => ctx.json({ body: await ctx.body.json() }), {
  body: Type.Object({
    name: Type.String(),
    age: Type.Optional(Type.Number()),
  }),
});
