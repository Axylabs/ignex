import { get } from "@ignex/core/http";
import { Type } from "typebox";

// In-memory "database" for the demo — real apps wrap their driver instead.
const products = new Map<string, { id: string; name: string; price: number }>(
  Array.from({ length: 250 }, (_, i) => [
    String(i + 1),
    { id: String(i + 1), name: `Product ${i + 1}`, price: (i + 1) * 10 },
  ]),
);

export default get(
  async (ctx) => {
    const id = ctx.params.id;

    // ctx.debug is a shared no-op unless the debugbar() plugin is registered —
    // call it unconditionally; the dashboard records these spans per request.
    const product = await ctx.debug.query("SELECT * FROM products WHERE id = ?", [id], async () => {
      await Bun.sleep(Number(id) % 3 === 0 ? 35 : 2); // simulate a slow row occasionally
      return products.get(id);
    });

    const cached = await ctx.debug.span(
      "cache: get product",
      "cache",
      async () => {
        await Bun.sleep(0.4);
        return null; // cache miss in the demo
      },
      { key: `product:${id}` },
    );

    await ctx.debug.span("serialize: build payload", "render", () => {
      return { product, cached };
    });

    if (!product) {
      return ctx.json({ error: "not_found" }, { status: 404 });
    }
    return ctx.json({ product });
  },
  {
    params: Type.Object({
      id: Type.String(),
    }),
  },
);
