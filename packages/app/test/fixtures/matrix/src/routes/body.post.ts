import { post } from "@ignex/core/http";

/** POST /body — content-type-driven parse summary (json/form/text/raw). */
export default post(async (ctx) => {
  const contentType = ctx.req.headers.get("content-type") ?? "";
  const value = await ctx.body();

  if (value instanceof ArrayBuffer) {
    return ctx.json({ contentType, bytes: value.byteLength });
  }

  return ctx.json({ contentType, value });
});
