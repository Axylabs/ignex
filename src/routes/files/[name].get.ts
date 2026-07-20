import { safeJoin } from "../../core";
import { get } from "../../core/http";

export default get(async (ctx) => {
  const path = safeJoin("uploads", ctx.params.name);

  return ctx.sendFile(path, {
    req: ctx.req,
    download: true,
    maxAge: 3600,
    swr: 86400,
  });
});