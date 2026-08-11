/**
 * Named-export route support (`export const httpGet = get(...)`).
 *
 * The "moxt DX" contract: a route file may export its handler as the default
 * OR as a named binding — the compiler discovers it either way and the route
 * path/method still come from the filename.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAsync } from "../src";
import { extractHandlerExportName, hasHandlerExportAST, parseModule } from "../src/utils/ast";
import { type FixtureLayout, materializeFixture } from "./helpers";

const baseOptions = (layout: FixtureLayout) => ({
  routesDir: layout.routesDir,
  outDir: layout.outDir,
  outFile: "server.js",
  minify: false,
  sourceMap: false,
  incremental: false,
  generateTypes: true,
  generateOpenAPI: true,
  generateClient: true,
  precompileValidators: true,
  precompileSerializers: true,
});

describe("AST: named-export handler extraction", () => {
  it("extracts a named wrapper export (get(...))", () => {
    const src = `import { get } from "@ignus/core/http";\nexport const httpGet = get(() => "Hello World");\n`;
    const parsed = parseModule(src);

    expect(parsed.hasHandlerExport).toBe(true);
    expect(parsed.handlerExportName).toBe("httpGet");
    expect(parsed.handler?.exportKind).toBe("named");
    expect(parsed.handler?.exportName).toBe("httpGet");
    expect(parsed.handler?.body).toContain("Hello World");
  });

  it("extracts a named bare-arrow export and detects ctx usage", () => {
    const src = `export const httpGet = (ctx) => ctx.json({ ok: ctx.query.q });\n`;
    const parsed = parseModule(src);

    expect(parsed.hasHandlerExport).toBe(true);
    expect(parsed.handler?.exportName).toBe("httpGet");
    expect(parsed.handler?.usage.json).toBe(true);
    expect(parsed.handler?.usage.query).toBe(true);
    expect(parsed.handler?.isSimpleParam).toBe(true);
  });

  it("extracts a named function declaration export", () => {
    const src = `export function httpGet(ctx) { return ctx.text("hi"); }\n`;
    const parsed = parseModule(src);

    expect(parsed.hasHandlerExport).toBe(true);
    expect(parsed.handlerExportName).toBe("httpGet");
    expect(parsed.handler?.exportKind).toBe("named");
    expect(parsed.handler?.usage.text).toBe(true);
  });

  it("detects schema on a named wrapper export (get(handler, schema))", () => {
    const src = `import { get } from "@ignus/core/http";\nexport const httpGet = get((ctx) => ({}), { query: { type: "object" } });\n`;
    const parsed = parseModule(src);

    expect(parsed.schemaExport).toBe(true);
    expect(parsed.hasHandlerExport).toBe(true);
  });

  it("tracks referenced named handlers as routes without inlining them", () => {
    const src = `import { get } from "@ignus/core/http";\nexport const httpGet = get(myHandler);\n`;
    const parsed = parseModule(src);

    expect(parsed.hasHandlerExport).toBe(true);
    expect(parsed.handlerExportName).toBe("httpGet");
    // Referenced handler body is not extractable → not an inline candidate.
    expect(parsed.handler).toBeNull();
  });

  it("does not treat non-handler modules as route modules", () => {
    const src = `export const config = { cache: 60 };\n`;
    const parsed = parseModule(src);

    expect(parsed.hasHandlerExport).toBe(false);
    expect(parsed.handler).toBeNull();
    expect(hasHandlerExportAST(parsed.ast)).toBe(false);
    expect(extractHandlerExportName(parsed.ast)).toBeUndefined();
  });

  it("prefers the default export when both styles are present", () => {
    const src = `export const httpGet = () => "named";\nexport default () => "default";\n`;
    const parsed = parseModule(src);

    expect(parsed.handler?.exportKind).toBe("default");
    expect(parsed.handlerExportName).toBeUndefined();
  });
});

describe("named-export routes (end-to-end compile)", () => {
  it("discovers all named-export modules as routes", async () => {
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout));

    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain('"/"');
    expect(result.code).toContain('"/echo"');
    expect(result.code).toContain('"/schema"');
  });

  it("hoists pure named-export constant responses (no runtime call)", async () => {
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout));

    expect(result.code).toContain("ignus named export");
  });

  it("inlines named-export handlers from self-contained modules", async () => {
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout));

    // echo.get is a pure, single-symbol named handler → inlined.
    expect(result.code).toContain("Inlined route handler");
  });

  it("wires named-export schemas into OpenAPI", async () => {
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout));
    expect(result.errors).toHaveLength(0);

    const openapi = JSON.parse(readFileSync(join(layout.outDir, "openapi.json"), "utf8")) as {
      paths: Record<string, Record<string, any>>;
    };

    const op = openapi.paths["/schema"]?.get;
    expect(op).toBeDefined();
    expect(op.parameters?.find((p: any) => p.name === "q")?.schema).toEqual({
      type: "string",
    });
    expect(op.responses["200"].content["application/json"].schema.properties.ok).toEqual({
      type: "boolean",
    });
  });

  it("emits named imports (aliased) for non-inline named handlers", async () => {
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout));

    // schema.get.ts is validated (not inlined) → imported via a named export.
    expect(result.code).toMatch(/import \{ httpGet as handler__h\d+ \}/);
  });

  it("forces the full context for routes using ctx.loader", async () => {
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout));
    expect(result.errors).toHaveLength(0);

    // loader.get.ts uses ctx.loader → codegen must build a real context via
    // createContext (the specialized context would lack `loader`).
    expect(result.code).toContain("createContext(req, params ?? EMPTY_PARAMS");
  });
});
