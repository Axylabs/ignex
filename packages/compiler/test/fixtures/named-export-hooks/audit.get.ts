// Named-export route with a runtime AFTER chain.
import { get } from "@ignex/core/http";

export const httpGet = get((ctx) => ctx.json({ ok: true }), {
  after: [(_ctx, response) => response],
});
