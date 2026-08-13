import { get } from "@ignex/core/http";

/** GET /cookies — echoes received cookie names and sets a response cookie. */
export default get(async (ctx) => {
  const seen = Object.keys(ctx.cookie);
  ctx.set.cookie = { ...ctx.set.cookie, seen: { value: "1" } };
  return ctx.json({ seen });
});
