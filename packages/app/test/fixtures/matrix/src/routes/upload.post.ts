import { post } from "@flux/core/http";

/** POST /upload — echoes multipart file metadata (no disk writes). */
export default post(async (ctx) => {
  const file = await ctx.body.file();

  if (!file) {
    return ctx.json({ error: "file required" }, { status: 400 });
  }

  return ctx.json({ name: file.name, size: file.size, type: file.type });
});
