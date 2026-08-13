import { get } from "@ignex/core/http";

/** GET /large — returns a JSON body above the compression threshold (1024 B). */
export default get(async (ctx) => {
  const items = Array.from({ length: 200 }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    value: `value-${i}-${"x".repeat(10)}`,
  }));
  return ctx.json({ items, total: items.length });
});
