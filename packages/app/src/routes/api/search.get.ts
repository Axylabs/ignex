import { get } from "@ignex/core/http";

/** GET /api/search — many query params; the iteration forces the parse work. */
export default get(async (ctx) => {
  let count = 0;
  let length = 0;
  for (const [key, value] of ctx.query) {
    count += 1;
    length += key.length + value.length;
  }
  return ctx.json({ ok: true, params: count, decodedLength: length });
});
