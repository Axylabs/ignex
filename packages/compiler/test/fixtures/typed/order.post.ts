import { post } from "@ignex/core/http";
import { Type } from "typebox";

/**
 * TypeBox schema-first route — used by the typed-artifact test to verify that
 * `routes.d.ts` references `Static<typeof schema.body>` instead of `unknown`.
 */
export const schema = {
  body: Type.Object({
    name: Type.String(),
    qty: Type.Integer({ minimum: 1 }),
  }),
};

export default post(async (ctx) => ctx.json({ ok: true }));
