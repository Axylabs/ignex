import { get } from "@ignex/core/http";
import { Type } from "typebox";

/** GET /validate-params/:id — params schema (`id` coerced to number). */
export default get(async (ctx) => ctx.json({ id: ctx.params.id, type: typeof ctx.params.id }), {
  params: Type.Object({
    id: Type.Number(),
  }),
});
