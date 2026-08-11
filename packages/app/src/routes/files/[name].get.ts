import { safeJoin } from "@ignus/core";
import { get } from "@ignus/core/http";

export default get(async (ctx) => {
  const name = ctx.params.name;

  if (!name) {
    return ctx.json({ error: "file name required" }, { status: 400 });
  }

  const path = safeJoin("uploads", name);

  return ctx.sendFile(path, {
    req: ctx.req,
    download: true,
    maxAge: 3600,
    swr: 86400,
  });
});
