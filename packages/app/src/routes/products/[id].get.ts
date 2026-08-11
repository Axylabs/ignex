import { get } from "@ignus/core/http";
import { Type } from "@sinclair/typebox";

export default get(
  async (ctx) => {
    return ctx.json({
      product: {
        id: ctx.params.id,
      },
    });
  },
  {
    params: Type.Object({
      id: Type.String(),
    }),
  },
);
