import { createJwt } from "@ignex/core";
import { get } from "@ignex/core/http";
import { BENCH_SECRET } from "../../../bench-data";

const jwt = createJwt({ secret: BENCH_SECRET });

/** GET /api/reports/:id — HS256 JWT verification on every request. */
export default get(async (ctx) => {
  const auth = await ctx.debug.span("verify: bearer token", "auth", async () => {
    const token = (ctx.req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    return token;
  });

  const claims = (await ctx.debug.span("crypto: jwt verify", "auth", () => jwt.verify(auth))) as {
    sub?: string;
  } | null;
  if (!claims) {
    return ctx.json({ error: "unauthorized" }, { status: 401 });
  }

  const report = await ctx.debug.query(
    "SELECT * FROM reports WHERE id = ? AND owner_id = ?",
    [ctx.params.id, claims.sub],
    async () => {
      await Bun.sleep(3);
      return { id: ctx.params.id, owner: claims.sub, rows: 42 };
    },
  );

  return ctx.json({ ok: true, report });
});
