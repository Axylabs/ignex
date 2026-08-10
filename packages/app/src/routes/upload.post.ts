import { mkdir } from "node:fs/promises";
import { post } from "@flux/core/http";

export default post(async (ctx) => {
  const file = await ctx.body.file();

  if (!file) {
    return ctx.json({ error: "file required" }, { status: 400 });
  }

  await mkdir("uploads", { recursive: true });

  const safeName = file.name.replace(/[^\w.-]+/g, "_");
  const storedName = `${Date.now().toString(36)}-${safeName}`;
  const dest = `uploads/${storedName}`;

  await Bun.write(dest, file);

  return ctx.json({
    ok: true,
    size: file.size,
    type: file.type,
    path: `/files/${storedName}`,
  });
});
