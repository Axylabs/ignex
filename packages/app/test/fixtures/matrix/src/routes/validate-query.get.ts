import { get } from "@ignex/core/http";
import { Type } from "typebox";

/** GET /validate-query — query schema (required `q`, optional `n` coerced to number). */
export default get(async (ctx) => ctx.json({ query: ctx.query }), {
  query: Type.Object({
    q: Type.String(),
    n: Type.Optional(Type.Number()),
  }),
});
