import { get } from "../../core/http";

export default get(async (ctx) => {
  return ctx.json({
    product: {
      id: ctx.params.id,
    },
  });
});