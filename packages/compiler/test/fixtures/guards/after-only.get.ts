// A route that declares ONLY an after chain (no before guards): the route
// must still emit the route.after stage (and take the full-context path).
import { get } from "@ignex/core/http";

export default get((ctx) => ctx.json({ ok: true }), {
  after: [
    (ctx, response) => {
      ctx.setState("audited", response.status);
    },
  ],
});
