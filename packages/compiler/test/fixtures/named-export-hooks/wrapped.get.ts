// Named export wrapped by an APP helper (not an HTTP wrapper): the wrapper may
// attach route-local hooks at runtime, so the route must stay un-inlined.
import { get } from "@ignex/core/http";
import { withGuards } from "../../lib/guards";

export const httpGet = withGuards(
  get((ctx) => ctx.json({ ok: true })),
  {
    permissions: ["hooks:read"],
  },
);
