import { get } from "@ignus/core/http";
import { Type } from "@sinclair/typebox";

/** GET /validate-headers — headers schema (lowercased `x-token` required). */
export default get(async (ctx) => ctx.json({ token: ctx.req.headers.get("x-token") }), {
  headers: Type.Object({
    "x-token": Type.String(),
  }),
});
