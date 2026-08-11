import { get } from "@flux/core/http";

/** GET /search — echoes the parsed query string (duplicate keys preserved). */
export default get(async (ctx) => {
  const entries = [...ctx.query.entries()];
  return ctx.json({ query: Object.fromEntries(entries), raw: entries });
});
