// First-class guard array: `before: [withGuards({ permissions })]` in the
// route schema — chained alongside any other guard.
import { get } from "@ignex/core/http";
import { withGuards } from "../../lib/guards";

export default get((ctx) => ctx.json({ ok: true }), {
  before: [withGuards({ permissions: ["invoices:read", "invoices:write"] })],
});
