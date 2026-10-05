import { join } from "node:path";
import { createTemplateDir, withLayout } from "@ignex/core";
import { get } from "@ignex/core/http";

// Templates live under the app source dir; the generated entry runs from the
// project root, so resolve relative to the working directory.
//
// Compile the registry ONCE and share the promise (like /catalog's precompiled
// payload): re-reading the directory and re-parsing every template per request
// is pure per-request I/O on the hot path. Memoized lazily (not at module
// load) so a missing directory still surfaces as a per-request 500 rather than
// an unhandled rejection at import time, and concurrent first requests await
// one scan instead of racing duplicates.
const viewsDir = join(process.cwd(), "src/views");
let registryPromise: ReturnType<typeof createTemplateDir> | undefined;
const templateRegistry = (): ReturnType<typeof createTemplateDir> =>
  (registryPromise ??= createTemplateDir(viewsDir));

/** GET /page — server-rendered HTML via templates (minijinja native / JS fallback). */
export default get(async (ctx) => {
  const registry = await templateRegistry();

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
