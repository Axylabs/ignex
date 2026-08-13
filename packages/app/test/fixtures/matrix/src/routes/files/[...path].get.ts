import { get } from "@ignex/core/http";

/** GET /files/*path — wildcard (catch-all) param echo. */
export default get(async (ctx) => {
  const path = (ctx.params as Record<string, string>).path ?? "";
  return ctx.json({ path });
});
