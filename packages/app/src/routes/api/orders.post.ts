import { post } from "@ignex/core/http";
import { Type } from "typebox";

const LineItem = Type.Object({
  sku: Type.String(),
  name: Type.String(),
  quantity: Type.Integer({ minimum: 1 }),
  unitPriceCents: Type.Integer({ minimum: 0 }),
  note: Type.Optional(Type.String()),
});

/** The orders body schema — compiled into the precompiled-Ajv body validator. */
const OrderBody = Type.Object({
  orderId: Type.String(),
  customer: Type.Object({
    id: Type.String(),
    email: Type.String(),
    name: Type.String(),
  }),
  shippingAddress: Type.Object({
    line1: Type.String(),
    city: Type.String(),
    region: Type.String(),
    postalCode: Type.String(),
    country: Type.String(),
  }),
  lineItems: Type.Array(LineItem),
  payment: Type.Object({ method: Type.String(), last4: Type.String() }),
  subtotalCents: Type.Integer(),
  taxCents: Type.Integer(),
  totalCents: Type.Integer(),
  currency: Type.String(),
});

/**
 * Declared body schema → the compiled server emits its precompiled-Ajv body
 * prelude, which parses the body ONCE, validates it, and hands the cached
 * value to the handler (`ctx.body.json = async () => __body`).
 *
 * Measured faster option first: precompiled Ajv is ~7.7x faster than castrum
 * `fast_schema` on this payload (`docs/performance-baseline-2026-08.md`), and
 * the `bun run bench:native:all` median audit reconfirms it (native/js 0.08x on the
 * probe; 1.4-1.6x slower than `JSON.parse` + Ajv on the real 15KB body, at
 * every size). `createSchemaValidator` is therefore pinned to the JS path in
 * SELECTION and the native one-pass `derive` is no longer wired here.
 */
export const schema = { body: OrderBody };

/** POST /api/orders — validated bulk JSON body, shaped into a summary. */
export default post(async (ctx) => {
  // The prelude already parsed + validated the body; this reads its cache.
  const body = await ctx.body.json<{ lineItems: unknown[]; totalCents: number }>();
  return ctx.json({
    ok: true,
    count: body.lineItems.length,
    total: body.totalCents,
  });
});
