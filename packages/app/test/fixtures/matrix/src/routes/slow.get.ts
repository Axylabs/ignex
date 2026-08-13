import { get } from "@ignex/core/http";

/** GET /slow — responds after a short delay (concurrency / timeout tests). */
export default get(async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  return ctx.json({ slow: true });
});
