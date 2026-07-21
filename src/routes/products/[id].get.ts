import { Type } from "@sinclair/typebox";
import { get } from "../../core/http";

export default get(async (ctx) => {
  return ctx.json({
    product: {
      id: ctx.params.id,
    },
  });
}, {
  params: Type.Object({
    id: Type.String()
  })
}
);