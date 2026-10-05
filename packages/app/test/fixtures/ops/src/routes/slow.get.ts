import { get } from "@ignex/core/http";

/** GET /slow — long enough that a SIGTERM lands while it is still in flight. */
export default get(async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return ctx.json({ slow: true });
});
