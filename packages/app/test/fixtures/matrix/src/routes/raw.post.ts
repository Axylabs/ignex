import { post } from "@ignex/core/http";

/** POST /raw — echoes raw byte length + first bytes (application/octet-stream). */
export default post(async (ctx) => {
  const buf = await ctx.body.arrayBuffer();
  const first = new TextDecoder().decode(buf.slice(0, 8));
  return ctx.json({ bytes: buf.byteLength, first });
});
