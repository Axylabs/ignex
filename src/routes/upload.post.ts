import { post } from "../core/http";
export default post(async (ctx) => {
  const file = await ctx.body.file();

  if (!file) {
    return ctx.json({ error: "file required" }, { status: 400 });
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const dest = Bun.file(`uploads/${Date.now().toString(36)}-${safeName}`);

  await Bun.write(dest, file);

  return ctx.json({
    ok: true,
    size: file.size,
    type: file.type,
    path: `/files/${dest.name?.split("/").pop()}`,
  });
});