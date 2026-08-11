import { all } from "@ignus/core/http";

/** ALL /echo — responds to every HTTP method with request facts. */
export default all(async (ctx) =>
  ctx.json({ method: ctx.method, path: ctx.path, query: Object.fromEntries(ctx.query) }),
);
