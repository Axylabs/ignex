import { get } from "@ignus/core/http";

/** GET /proxy — proxies to the `?target=` URL (used by proxy integration tests). */
export default get(async (ctx) => {
  const target = ctx.query.get("target");
  if (!target) {
    return ctx.json({ error: "target required" }, { status: 400 });
  }
  return ctx.proxy(target, { timeoutMs: 2000 });
});
