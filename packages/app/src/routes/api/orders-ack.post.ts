import { post } from "@ignex/core/http";
import { Type } from "@sinclair/typebox";

/**
 * Schema-first validate-and-ack route.
 *
 * Exports a plain `schema` with a `body` part and the handler NEVER reads
 * `ctx.body` — so the compiled server's per-route native stack validates the
 * raw body bytes natively (bytes-in / verdict-out: `requireJsonBody` +
 * `validateBody` on the packed frame) and the handler is called only when the
 * body is valid. On the native path there is no `JSON.parse`, no DOM build and
 * no Ajv call for the happy path; a missing addon falls back to the JS
 * `JSON.parse` + Ajv prelude (byte-parity).
 *
 * This is the Phase-2/4 e2e proof: `nativeRoutes` is ON by default, so this
 * route is the real served-request exercise of the native body stage.
 */
export const schema = {
  body: Type.Object({
    orderId: Type.String(),
    quantity: Type.Integer({ minimum: 1 }),
    totalCents: Type.Integer(),
  }),
};

export default post(async (ctx) => ctx.json({ ok: true }));
