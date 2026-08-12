import { createJwt } from "@ignus/core";
import { get } from "@ignus/core/http";
import { BENCH_SECRET } from "../../../bench-data";

const jwt = createJwt({ secret: BENCH_SECRET });

/** GET /api/reports/:id — HS256 JWT verification on every request. */
export default get(async (ctx) => {
  const auth = ctx.req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  const claims = jwt.verify(token);
  if (!claims) {
    return ctx.json({ error: "unauthorized" }, { status: 401 });
  }

  return ctx.json({ ok: true, report: ctx.params.id });
});
