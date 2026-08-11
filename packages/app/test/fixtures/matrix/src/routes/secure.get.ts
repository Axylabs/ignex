import { get } from "@ignus/core/http";

/** GET /secure — requires `Authorization: Bearer secret-token`. */
export default get(async (ctx) => {
  if (ctx.req.headers.get("authorization") !== "Bearer secret-token") {
    return ctx.json({ error: "unauthorized" }, { status: 401 });
  }
  return ctx.json({ secure: true });
});
