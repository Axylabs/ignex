import { join } from "node:path";
import { createTemplateDir, withLayout } from "@ignex/core";
import { get } from "@ignex/core/http";

/** GET /page — server-rendered HTML via templates (minijinja native / JS fallback). */
export default get(async (ctx) => {
  // Templates live under the app source dir; the generated entry runs from the
  // project root, so resolve relative to the working directory.
  const registry = await createTemplateDir(join(process.cwd(), "src/views"));

  // Functional composition: layout(pageRenderer)(data) → layout(page(data), data).
  const page = withLayout((content, data) => registry.render("layout", { ...data, content }))(
    (data) => registry.render("home", data),
  );

  const html = page({
    title: "Ignex demo",
    name: ctx.query.get("name") ?? "world",
    locale: ctx.getState<string>("locale") ?? "en",
    features: ["routing", "templates", "i18n", "native"],
  });

  return ctx.html(html);
});
