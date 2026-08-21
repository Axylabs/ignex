/**
 * Generator tests for the feature/demo route templates (`ignex create
 * --features examples`, ...) in `templates/routes.ts`.
 *
 * Covers the generated handlers' shape: method-specific imports, correct
 * `ctx` usage (regression: `cacheRouteTemplate` used to reference `ctx` in a
 * zero-arg handler → `ReferenceError`), and no `await import` / `as any`.
 */
import { expect, test } from "vitest";
import {
  appConfigTemplate,
  cacheRouteTemplate,
  healthRouteTemplate,
  indexRouteTemplate,
  productAddRouteTemplate,
  productByIdRouteTemplate,
  proxyRouteTemplate,
  sseRouteTemplate,
  uploadRouteTemplate,
} from "../src/templates/routes.js";

test("index/health routes use a named export and a ctx-taking handler", () => {
  const index = indexRouteTemplate("Demo");
  expect(index).toContain('import { get } from "@ignex/core/http";');
  expect(index).toContain('export const httpGet = get((ctx) => ctx.json({ name: "Demo" }));');

  const health = healthRouteTemplate();
  expect(health).toContain('export const httpGet = get((ctx) => ctx.text("ok"));');
});

test("app.config wires the openapi() and session() baseline + selected plugins", () => {
  const code = appConfigTemplate({ plugins: true });
  // Selected `--features` plugins come from ./plugins/index.js (spread).
  expect(code).toContain('import { plugins } from "./plugins/index.js";');
  expect(code).toContain("  ...plugins,");
  // Baseline: openapi() docs plugin always present.
  expect(code).toContain("openapi()");
  expect(code).not.toContain("generateOpenAPI(");

  // Without a plugins file (no plugin features), the app config stays valid.
  const bare = appConfigTemplate();
  expect(bare).not.toContain("./plugins/index.js");
  expect(bare).toContain("openapi()");
  expect(bare).toContain("session({");
});

test("product routes read params/body with a ctx-taking handler", () => {
  const byId = productByIdRouteTemplate();
  expect(byId).toContain("export default get((ctx) => {");
  expect(byId).toContain("const id = ctx.params.id;");

  const add = productAddRouteTemplate();
  expect(add).toContain("export default post(async (ctx) => {");
  expect(add).toContain("await ctx.body.json()");
});

test("upload route parses the form body via ctx.body.formData()", () => {
  const code = uploadRouteTemplate();
  expect(code).toContain("export default post(async (ctx) => {");
  expect(code).toContain("const form = await ctx.body.formData();");
});

test("cache route references ctx only inside a ctx-taking handler", () => {
  const code = cacheRouteTemplate();
  expect(code).toContain("export default get((ctx) =>");
  expect(code).toContain("withBrowserCache(ctx.json({ cached: true }), { maxAge: 10 })");
  expect(code).not.toMatch(/get\(\(\) =>[^)]*ctx\./);
});

test("sse/proxy routes need no ctx and never reference it", () => {
  const sse = sseRouteTemplate();
  expect(sse).toContain("export default get(() =>");
  expect(sse).not.toContain("ctx.");

  const proxy = proxyRouteTemplate();
  expect(proxy).toContain("export default get(() => proxyRequest(");
  expect(proxy).not.toContain("ctx.");
});

test("feature routes never use await import or as any", () => {
  for (const code of [
    cacheRouteTemplate(),
    productByIdRouteTemplate(),
    productAddRouteTemplate(),
    uploadRouteTemplate(),
    sseRouteTemplate(),
    proxyRouteTemplate(),
  ]) {
    expect(code).not.toContain("await import(");
    expect(code).not.toContain("as any");
  }
});
