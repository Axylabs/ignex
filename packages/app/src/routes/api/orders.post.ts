import { post } from "@ignus/core/http";
import { Type } from "@sinclair/typebox";

const LineItem = Type.Object({
  sku: Type.String(),
  name: Type.String(),
  quantity: Type.Integer({ minimum: 1 }),
  unitPriceCents: Type.Integer({ minimum: 0 }),
  note: Type.Optional(Type.String()),
});

/** POST /api/orders — realistic large JSON body validated against a schema. */
export default post(
  async (ctx) => {
    const body = await ctx.body.json<{ lineItems?: unknown[]; totalCents?: number }>();
    return ctx.json({
      ok: true,
      count: body.lineItems?.length ?? 0,
      total: body.totalCents,
    });
  },
  {
    body: Type.Object({
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
    }),
  },
);
