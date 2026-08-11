import { get } from "@ignus/core/http";

let count = 0;

/** GET /count — increments a module counter (concurrency ordering tests). */
export default get(async (ctx) => ctx.json({ count: ++count }));
