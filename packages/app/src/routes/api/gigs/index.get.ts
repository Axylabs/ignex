import { get } from "@ignex/core/http";
import { db } from "../../../db.js";

export default get(async (ctx) => {
  const page = Math.max(1, Number(ctx.query.get("page") ?? "1"));
  const limit = Math.min(100, Math.max(1, Number(ctx.query.get("limit") ?? "20")));
  const result = await db.paginateFlexible("gigs", {}, { page, limit, sort: { createdAt: -1 } });
  return ctx.json(result);
});
