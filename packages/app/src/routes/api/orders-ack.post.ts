import { post } from "@ignex/core/http";
import { Type } from "typebox";

/**
 * Schema-first validate-and-ack route.
 *
 * Exports a plain `schema` with a `body` part and the handler NEVER reads
 * `ctx.body`. The default compiled server validates with precompiled Ajv. With
 * `nativeRoutes: true`, an eligible build can instead validate raw body bytes
 * through the native `requireJsonBody` + `validateBody` stages; a missing addon
 * falls back to the JS `JSON.parse` + Ajv prelude with identical behavior.
 */
export const schema = {
  body: Type.Object({
    orderId: Type.String(),
    quantity: Type.Integer({ minimum: 1 }),
    totalCents: Type.Integer(),
  }),
};

export default post(async (ctx) => ctx.json({ ok: true }));
