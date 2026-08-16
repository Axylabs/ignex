import { expect, test } from "vitest";
import { httpExportName, routeFileTemplate } from "../src/templates/route.js";
import { parseRouteInput } from "../src/utils/route.js";

test("parses static route", () => {
  const parsed = parseRouteInput("health.get");

  expect(parsed.method).toBe("get");
  expect(parsed.file).toBe("health.get.ts");
  expect(parsed.routePath).toBe("/health");
  expect(parsed.paramNames).toEqual([]);
});

test("parses dynamic route", () => {
  const parsed = parseRouteInput("products/[id].get");

  expect(parsed.method).toBe("get");
  expect(parsed.file).toBe("products/[id].get.ts");
  expect(parsed.routePath).toBe("/products/:id");
  expect(parsed.paramNames).toEqual(["id"]);
});

test("parses method flag", () => {
  const parsed = parseRouteInput("products/add", "post");

  expect(parsed.method).toBe("post");
  expect(parsed.file).toBe("products/add.post.ts");
  expect(parsed.routePath).toBe("/products/add");
});

test("normalizes delete to del", () => {
  const parsed = parseRouteInput("products/[id].delete");

  expect(parsed.method).toBe("del");
  expect(parsed.file).toBe("products/[id].del.ts");
});

test("rejects parent-directory traversal (../..)", () => {
  expect(() => parseRouteInput("../../x")).toThrow(/inside the routes directory/);
  expect(() => parseRouteInput("a/../../b")).toThrow(/inside the routes directory/);
  expect(() => parseRouteInput("/../x")).toThrow(/inside the routes directory/);
});

test("rejects Windows/backslash path segments", () => {
  expect(() => parseRouteInput("api\\users")).toThrow(/inside the routes directory/);
  expect(() => parseRouteInput("C:\\x")).toThrow(/inside the routes directory/);
});

test("keeps dotted-but-relative names like foo..bar", () => {
  const parsed = parseRouteInput("foo..bar");
  expect(parsed.file).toBe("foo..bar.get.ts");
  expect(parsed.routePath).toBe("/foo..bar");
});

test("httpExportName maps methods to conventional identifiers", () => {
  expect(httpExportName("get")).toBe("httpGet");
  expect(httpExportName("post")).toBe("httpPost");
  expect(httpExportName("put")).toBe("httpPut");
  expect(httpExportName("patch")).toBe("httpPatch");
  expect(httpExportName("del")).toBe("httpDelete");
  expect(httpExportName("all")).toBe("httpAll");
});

test("default route template uses export default", () => {
  const parsed = parseRouteInput("hello.get");
  const code = routeFileTemplate(parsed);

  expect(code).toContain('import { get } from "@ignex/core/http";');
  expect(code).toContain('export default get((ctx) => ctx.text("OK"));');
  expect(code).not.toContain("export const httpGet");
});

test("named route template uses export const httpGet", () => {
  const parsed = parseRouteInput("hello.get");
  const code = routeFileTemplate(parsed, { named: true });

  expect(code).toContain('import { get } from "@ignex/core/http";');
  expect(code).toContain('export const httpGet = get((ctx) => ctx.text("OK"));');
  expect(code).not.toContain("export default");
});

test("named dynamic template wires params into a named handler", () => {
  const parsed = parseRouteInput("products/[id].get");
  const code = routeFileTemplate(parsed, { named: true });

  expect(code).toContain("export const httpGet = get((ctx) => {");
  expect(code).toContain("const { id } = ctx.params;");
});

test("named schema template emits schema export + named handler", () => {
  const parsed = parseRouteInput("products/[id].get");
  const code = routeFileTemplate(parsed, { schema: true, named: true });

  expect(code).toContain("export const schema = {");
  expect(code).toContain("export const httpGet = get(");
  expect(code).toContain("params: Type.Object({ id: Type.String() }),");
});

test("named post template uses httpPost", () => {
  const parsed = parseRouteInput("products/add", "post");
  const code = routeFileTemplate(parsed, { named: true });

  expect(code).toContain("export const httpPost = post(async (ctx) => {");
  expect(code).toContain("await ctx.body.json();");
});
