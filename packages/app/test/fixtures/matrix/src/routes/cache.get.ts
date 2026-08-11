import { get } from "@ignus/core/http";

let cacheHits = 0;

/** GET /cache — single-flight response cache (shared across concurrent requests). */
export default get(async (ctx) =>
  ctx.cache(async () => {
    cacheHits += 1;
    return ctx.json({ hits: cacheHits });
  }),
);
