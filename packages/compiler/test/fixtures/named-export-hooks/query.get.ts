// Named-export route that reads ctx.query WITHOUT a query schema: the
// URLSearchParams contract must survive the full-context prelude.
import { get } from "@ignex/core/http";
import { Type } from "typebox";
import { requireAuth } from "../../lib/guards";

const response = Type.Object({ ok: Type.Boolean() });

export const httpGet = get((ctx) => ctx.json({ ok: ctx.query.get("q") !== null }), {
  before: [requireAuth()],
  response,
});
