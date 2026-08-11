/**
 * AST utility layer tests.
 *
 * Covers every public function of `src/utils/ast` (walker primitives, import /
 * export / symbol extraction, handler extraction, ctx-usage detection, purity,
 * constant evaluation, response-type inference, schema/config detection, and
 * the parse bridge with its content-keyed memoization).
 *
 * Focus areas:
 * - edge cases the old monolithic `ast.ts` handled implicitly (destructured
 *   params, aliases, computed members, referenced handlers)
 * - hardening regressions (conditional / multi-return handlers must NOT be
 *   hoisted as constants, malformed source must not throw)
 * - parser-agnostic behavior (works with oxc-parser or Bun.Transpiler)
 */
import { beforeEach, describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../src/diagnostics";
import {
  clearParseCache,
  type ExtractedHandler,
  estimateNodeCount,
  evaluateConstantNode,
  extractConstantReturn,
  extractExportsAST,
  extractHandler,
  extractHandlerExport,
  extractHandlerExportName,
  extractHandlerNodeAST,
  extractImportsAST,
  extractRouteConfigAST,
  extractSymbolsAST,
  hasConfigExportAST,
  hasDefaultExportAST,
  hasHandlerExportAST,
  hasSchemaExportAST,
  inferResponseTypeAST,
  isPureBodyAST,
  nodeEnd,
  nodeStart,
  parseModule,
  walk,
  walkSome,
  walkUntil,
} from "../src/utils/ast";

beforeEach(() => {
  clearParseCache();
});

/** Assert a value is defined and narrow it — avoids non-null assertions. */
const defined = <T>(value: T | undefined): T => {
  expect(value).toBeDefined();
  return value as T;
};

// ---------------------------------------------------------------------------
// Walker primitives
// ---------------------------------------------------------------------------

describe("walker primitives", () => {
  const ast = parseModule(`const a = 1; function f() { return a; } const b = 2;`).ast;

  it("walk visits every node kind", () => {
    const kinds = new Set<string>();
    walk(ast, (n) => kinds.add(n.type));
    expect(kinds.has("Program")).toBe(true);
    expect(kinds.has("VariableDeclaration")).toBe(true);
    expect(kinds.has("FunctionDeclaration")).toBe(true);
    expect(kinds.has("ReturnStatement")).toBe(true);
  });

  it("walk never descends through metadata keys (parent/loc/range)", () => {
    let sawParent = false;
    walk(ast, (n) => {
      if (n.parent !== undefined) sawParent = true;
    });
    // `walk` doesn't set parent; ensure it also doesn't traverse into one.
    expect(sawParent).toBe(false);
  });

  it("walkUntil finds the first match and stops", () => {
    const hit = walkUntil<any>(ast, (n) => (n.type === "FunctionDeclaration" ? n : undefined));
    expect(hit).toBeDefined();
    expect(hit.id.name).toBe("f");
  });

  it("walkUntil returns undefined when nothing matches", () => {
    const hit = walkUntil(ast, (n) => (n.type === "AwaitExpression" ? n : undefined));
    expect(hit).toBeUndefined();
  });

  it("walkSome stops early when the visitor returns true", () => {
    let visited = 0;
    const stopped = walkSome(ast, (n) => {
      visited++;
      return n.type === "FunctionDeclaration";
    });
    expect(stopped).toBe(true);
    // Program + VariableDeclaration + declarator + id + init + FunctionDeclaration
    expect(visited).toBeLessThanOrEqual(6);
  });

  it("walk supports pruning a subtree by returning false", () => {
    const returned = parseModule(`function f() { return 1; }`).ast;
    let pruned = 0;
    walk(returned, (n) => {
      pruned++;
      if (n.type === "FunctionDeclaration") return false;
    });
    let full = 0;
    walk(returned, () => full++);
    expect(pruned).toBeGreaterThan(0);
    expect(pruned).toBeLessThan(full);
  });

  it("nodeStart / nodeEnd return consistent offsets", () => {
    const fn = walkUntil<any>(ast, (n) => (n.type === "FunctionDeclaration" ? n : undefined));
    const start = nodeStart(fn);
    const end = nodeEnd(fn);
    expect(typeof start).toBe("number");
    expect(typeof end).toBe("number");
    expect((end as number) - (start as number)).toBeGreaterThan(0);
  });

  it("tolerates undefined input", () => {
    expect(walkUntil(undefined, () => true)).toBeUndefined();
    expect(walkSome(undefined, () => true)).toBe(false);
    expect(() => walk(undefined, () => {})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Import / export extraction
// ---------------------------------------------------------------------------

describe("extractImportsAST", () => {
  it("extracts default, named (with aliases), namespace and side-effect imports", () => {
    const src = [
      `import def from "a";`,
      `import { x, y as z } from "b";`,
      `import * as ns from "c";`,
      `import "side-effect";`,
    ].join("\n");
    const imports = extractImportsAST(parseModule(src).ast);

    expect(imports).toHaveLength(4);

    const a = defined(imports.find((i) => i.source === "a"));
    expect(a.defaultName).toBe("def");
    expect(a.names).toEqual([]);

    const b = defined(imports.find((i) => i.source === "b"));
    expect(b.names).toEqual(["x", "z"]);
    expect(b.defaultName).toBeUndefined();
    expect(b.namespaceName).toBeUndefined();

    const c = defined(imports.find((i) => i.source === "c"));
    expect(c.namespaceName).toBe("ns");

    const side = defined(imports.find((i) => i.source === "side-effect"));
    expect(side.names).toEqual([]);
    expect(side.defaultName).toBeUndefined();
    expect(side.namespaceName).toBeUndefined();
  });

  it("returns [] for a module with no imports", () => {
    expect(extractImportsAST(parseModule(`export default () => 1;`).ast)).toEqual([]);
  });

  it("returns [] for an empty program", () => {
    expect(extractImportsAST({ type: "Program", body: [] })).toEqual([]);
  });
});

describe("extractExportsAST", () => {
  it("extracts default, declaration and specifier exports", () => {
    const src = [
      `export default function root() {}`,
      `export const a = 1;`,
      `export function b() {}`,
      `const c = 1; export { c };`,
    ].join("\n");
    const exports = extractExportsAST(parseModule(src).ast);
    const names = exports.map((e) => `${e.kind}:${e.name}`);
    // `export default function root(){}` — the default binding is named
    // "default" (oxc stores the function name in `id.name`).
    expect(names).toContain("default:default");
    expect(names).toContain("named:a");
    expect(names).toContain("named:b");
    expect(names).toContain("named:c");
  });

  it("extracts namespace re-exports", () => {
    const exports = extractExportsAST(parseModule(`export * as ns from "x";`).ast);
    expect(exports).toContainEqual(expect.objectContaining({ kind: "namespace", name: "ns" }));
  });
});

describe("hasDefaultExportAST", () => {
  it("detects a default export", () => {
    expect(hasDefaultExportAST(parseModule(`export default () => 1;`).ast)).toBe(true);
  });

  it("returns false when only named exports exist", () => {
    expect(hasDefaultExportAST(parseModule(`export const x = 1;`).ast)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Handler extraction
// ---------------------------------------------------------------------------

describe("extractHandler / extractHandlerExport", () => {
  it("extracts a default wrapper export (get(async () => …))", () => {
    const src = `import { get } from "@ignus/core/http";\nexport default get(async (ctx) => ctx.json({ ok: true }));\n`;
    const parsed = parseModule(src);

    expect(parsed.handler).not.toBeNull();
    expect(parsed.handler?.exportKind).toBe("default");
    expect(parsed.handler?.isAsync).toBe(true);
    expect(parsed.handler?.paramName).toBe("ctx");
    expect(parsed.handler?.isSimpleParam).toBe(true);
    expect(parsed.handler?.usage.json).toBe(true);
  });

  it("extracts a bare default arrow and its body slice", () => {
    const src = `export default () => ({ hello: "world" });\n`;
    const parsed = parseModule(src);

    expect(parsed.handler?.exportKind).toBe("default");
    expect(parsed.handler?.body).toContain('hello: "world"');
  });

  it("extracts a default function declaration", () => {
    const src = `export default function root(ctx) { return ctx.text("hi"); }\n`;
    const parsed = parseModule(src);

    expect(parsed.handler?.isAsync).toBe(false);
    expect(parsed.handler?.usage.text).toBe(true);
  });

  it("extracts a named wrapper export", () => {
    const src = `export const httpGet = get(() => "Hello World");\n`;
    const parsed = parseModule(src);

    expect(parsed.handler?.exportKind).toBe("named");
    expect(parsed.handler?.exportName).toBe("httpGet");
    expect(parsed.handlerExportName).toBe("httpGet");
  });

  it("recognizes referenced handlers as routes but does not extract them", () => {
    const src = `export const httpGet = get(myHandler);\n`;
    const parsed = parseModule(src);

    expect(parsed.hasHandlerExport).toBe(true);
    expect(parsed.handlerExportName).toBe("httpGet");
    expect(parsed.handler).toBeNull();
    expect(extractHandlerNodeAST(parsed.ast)).toBeNull();
  });

  it("extractHandler (legacy API) only handles default exports", () => {
    const src = `export default () => "d";`;
    const parsed = parseModule(src);
    const h = extractHandler(src, parsed.ast);
    expect(h).not.toBeNull();
    expect(h?.exportKind).toBe("default");
  });

  it("extractHandlerExport resolves named exports directly", () => {
    const src = `export const httpGet = (ctx) => ctx.text("hi");`;
    const parsed = parseModule(src);
    const h = extractHandlerExport(src, parsed.ast);

    expect(h).not.toBeNull();
    expect(h?.exportKind).toBe("named");
    expect(h?.exportName).toBe("httpGet");
    expect(h?.usage.text).toBe(true);
  });

  it("extraction tolerates a missing source string (defensive)", () => {
    const parsed = parseModule(`export default () => "d";`);
    // A malformed caller passing no source must not throw; body is empty.
    const h = extractHandler(undefined as unknown as string, parsed.ast);
    expect(h).not.toBeNull();
    expect(h?.exportKind).toBe("default");
    expect(h?.body).toBe("");
  });

  it("prefers the default export over a named handler", () => {
    const src = `export const httpGet = () => "named";\nexport default () => "default";\n`;
    const parsed = parseModule(src);

    expect(parsed.handler?.exportKind).toBe("default");
    expect(parsed.handlerExportName).toBeUndefined();
  });

  it("hasHandlerExportAST is true for any default export", () => {
    expect(hasHandlerExportAST(parseModule(`export default 42;`).ast)).toBe(true);
  });

  it("hasHandlerExportAST is true for named function declarations", () => {
    expect(hasHandlerExportAST(parseModule(`export function httpGet() {}`).ast)).toBe(true);
  });

  it("hasHandlerExportAST is false for non-handler modules", () => {
    expect(hasHandlerExportAST(parseModule(`const x = 1;`).ast)).toBe(false);
  });

  it("extractHandlerExportName is undefined for default-export modules", () => {
    const src = `export default () => "d";`;
    expect(extractHandlerExportName(parseModule(src).ast)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ctx-usage detection
// ---------------------------------------------------------------------------

describe("ctx-usage detection", () => {
  const usageOf = (src: string): ExtractedHandler["usage"] => {
    const parsed = parseModule(src);
    expect(parsed.handler).not.toBeNull();
    return parsed.handler?.usage;
  };

  it("detects direct ctx member usage", () => {
    const u = usageOf(
      `export default (ctx) => ctx.json({ q: ctx.query.q, h: ctx.headers.x, p: ctx.params.id, b: ctx.body });`,
    );
    expect(u.json).toBe(true);
    expect(u.query).toBe(true);
    expect(u.headers).toBe(true);
    expect(u.params).toBe(true);
    expect(u.body).toBe(true);
    expect(u.req).toBe(false);
  });

  it("detects destructured param usage", () => {
    const u = usageOf(`export default ({ query, params }) => ({ q: query.q, p: params.p });`);
    expect(u.query).toBe(true);
    expect(u.params).toBe(true);
  });

  it("detects aliases (`const b = ctx.body;`)", () => {
    const u = usageOf(`export default (ctx) => { const b = ctx.body; return ctx.json({ b }); };`);
    expect(u.body).toBe(true);
    expect(u.json).toBe(true);
  });

  it("detects computed member access with literal keys", () => {
    const u = usageOf(`export default (ctx) => ctx["params"].id;`);
    expect(u.params).toBe(true);
  });

  it("does not flag free variables that are not the context", () => {
    const u = usageOf(
      `export default (ctx) => { const other = { json: () => 1 }; return other.json(); };`,
    );
    expect(u.json).toBe(false);
  });

  it("does not flag destructured keys that are never used", () => {
    const u = usageOf(`export default ({ query }) => 1;`);
    expect(u.query).toBe(false);
  });

  it("tracks req/url/method/state/cookie/set/loader flags", () => {
    const u = usageOf(
      `export default (ctx) => { ctx.state.set("k", ctx.req.url); ctx.cookie.set("a", "b"); ctx.loader.load("x"); return ctx.empty(); };`,
    );
    expect(u.req).toBe(true);
    expect(u.url).toBe(true);
    expect(u.state).toBe(true);
    expect(u.cookie).toBe(true);
    expect(u.loader).toBe(true);
    expect(u.set).toBe(true);
    expect(u.empty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

describe("extractSymbolsAST", () => {
  it("extracts functions and const arrows with call graph", () => {
    const src = [
      `function a() { b(); }`,
      `function b() { return 1; }`,
      `const c = () => a();`,
      `export default a;`,
    ].join("\n");
    const symbols = extractSymbolsAST(src, parseModule(src).ast);

    const a = defined(symbols.find((s) => s.name === "a"));
    expect(a.kind).toBe("function");
    expect(a.calls).toContain("b");
    expect(a.isDefaultExport).toBe(false);

    const b = defined(symbols.find((s) => s.name === "b"));
    expect(b.calledBy).toContain("a");
    expect(b.hotness).toBe(1);

    const c = defined(symbols.find((s) => s.name === "c"));
    expect(c.kind).toBe("const");
    expect(c.calls).toContain("a");
  });

  it("records positive source sizes", () => {
    const src = `function f() { return 1; }`;
    const symbols = extractSymbolsAST(src, parseModule(src).ast);
    expect(symbols[0].size).toBeGreaterThan(0);
  });

  it("records async flags and param names", () => {
    const src = `async function f(a, b) {}`;
    const symbols = extractSymbolsAST(src, parseModule(src).ast);
    expect(symbols[0].isAsync).toBe(true);
    expect(symbols[0].params).toEqual(["a", "b"]);
  });

  it("excludes a symbol from its own callers", () => {
    const src = `function f() { return f(); }`; // recursion
    const symbols = extractSymbolsAST(src, parseModule(src).ast);
    expect(symbols[0].calls).toEqual([]); // self-call filtered
    expect(symbols[0].calledBy).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Purity analysis
// ---------------------------------------------------------------------------

describe("isPureBodyAST", () => {
  it("accepts constant-shaped bodies", () => {
    expect(isPureBodyAST(parseModule(`export default () => ({ hello: "world" });`).ast)).toBe(true);
    expect(isPureBodyAST(parseModule(`export default () => "pong";`).ast)).toBe(true);
  });

  it("rejects Date / Math.random / console / fetch", () => {
    expect(isPureBodyAST(parseModule(`export default () => Date.now();`).ast)).toBe(false);
    expect(isPureBodyAST(parseModule(`export default () => Math.random();`).ast)).toBe(false);
    expect(isPureBodyAST(parseModule(`export default () => console.log("x");`).ast)).toBe(false);
    expect(isPureBodyAST(parseModule(`export default () => fetch("/x");`).ast)).toBe(false);
  });

  it("rejects `new Date()` and impure constructors", () => {
    expect(isPureBodyAST(parseModule(`export default () => new Date();`).ast)).toBe(false);
    expect(isPureBodyAST(parseModule(`export default () => new Map();`).ast)).toBe(false);
  });

  it("rejects await", () => {
    expect(
      isPureBodyAST(parseModule(`export default async () => { await 1; return 2; };`).ast),
    ).toBe(false);
  });

  it("rejects modules whose helpers are impure", () => {
    const src = `const helper = () => Date.now();\nexport default () => helper();`;
    expect(isPureBodyAST(parseModule(src).ast)).toBe(false);
  });

  it("accepts pure helper calls", () => {
    const src = `const add = (a, b) => a + b;\nexport default () => add(1, 2);`;
    expect(isPureBodyAST(parseModule(src).ast)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Constant evaluation
// ---------------------------------------------------------------------------

describe("evaluateConstantNode", () => {
  const ok = (value: unknown) => expect.objectContaining({ ok: true, value });

  it("evaluates literals", () => {
    const parsed = parseModule(`export default () => "x";`);
    const body = parsed.handler ? extractBodyNode(parsed.ast) : null;
    // Fall back to a direct probe through extractConstantReturn.
    expect(extractConstantReturn(parsed.ast)).toEqual(ok("x"));
    expect(body).not.toBeNull();
  });

  it("evaluates template literals without expressions", () => {
    const r = extractConstantReturn(parseModule("export default () => `hi there`;").ast);
    expect(r).toEqual(ok("hi there"));
  });

  it("evaluates unary -, + and !", () => {
    expect(
      evaluateConstantNode({
        type: "UnaryExpression",
        operator: "-",
        argument: { type: "Literal", value: 5 },
      }),
    ).toEqual(ok(-5));
    expect(
      evaluateConstantNode({
        type: "UnaryExpression",
        operator: "+",
        argument: { type: "Literal", value: "3" },
      }),
    ).toEqual(ok(3));
    expect(
      evaluateConstantNode({
        type: "UnaryExpression",
        operator: "!",
        argument: { type: "Literal", value: false },
      }),
    ).toEqual(ok(true));
  });

  it("evaluates array and object literals", () => {
    const arr = evaluateConstantNode({
      type: "ArrayExpression",
      elements: [
        { type: "Literal", value: 1 },
        { type: "Literal", value: 2 },
      ],
    });
    expect(arr).toEqual(ok([1, 2]));

    const obj = evaluateConstantNode({
      type: "ObjectExpression",
      properties: [
        {
          type: "Property",
          kind: "init",
          computed: false,
          key: { type: "Identifier", name: "a" },
          value: { type: "Literal", value: 1 },
        },
      ],
    });
    expect(obj).toEqual(ok({ a: 1 }));
  });

  it("evaluates `undefined` identifiers", () => {
    expect(evaluateConstantNode({ type: "Identifier", name: "undefined" })).toEqual(ok(undefined));
  });

  it("fails on non-constant constructs", () => {
    expect(
      evaluateConstantNode({
        type: "CallExpression",
        callee: { type: "Identifier", name: "f" },
        arguments: [],
      }),
    ).toEqual({ ok: false });
    expect(evaluateConstantNode({ type: "ConditionalExpression" })).toEqual({ ok: false });
    expect(evaluateConstantNode({ type: "SpreadElement" })).toEqual({ ok: false });
    expect(evaluateConstantNode({ type: "Literal", value: 10n })).toEqual({ ok: false }); // BigInt
    expect(
      evaluateConstantNode({ type: "ObjectExpression", properties: [{ type: "SpreadElement" }] }),
    ).toEqual({ ok: false });
  });

  it("treats parenthesized / TS wrappers transparently", () => {
    const wrapped = evaluateConstantNode({
      type: "ParenthesizedExpression",
      expression: { type: "Literal", value: 7 },
    });
    expect(wrapped).toEqual(ok(7));
  });
});

/** Return the handler function node's expression/return argument. */
function extractBodyNode(ast: any): any {
  const fn = extractHandlerNodeAST(ast);
  return fn?.body ?? null;
}

describe("extractConstantReturn (hardening)", () => {
  it("extracts expression-bodied constants", () => {
    expect(
      extractConstantReturn(parseModule(`export default () => ({ hello: "world" });`).ast),
    ).toEqual(expect.objectContaining({ ok: true, value: { hello: "world" } }));
    expect(extractConstantReturn(parseModule(`export default () => "pong";`).ast)).toEqual(
      expect.objectContaining({ ok: true, value: "pong" }),
    );
  });

  it("extracts a single block return", () => {
    const r = extractConstantReturn(parseModule(`export default () => { return { a: 1 }; };`).ast);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: 1 });
  });

  it("extracts constants from named-export handlers", () => {
    const r = extractConstantReturn(
      parseModule(`export const httpGet = () => "ignus named export";`).ast,
    );
    expect(r).toEqual(expect.objectContaining({ ok: true, value: "ignus named export" }));
  });

  it("rejects multi-return handlers (regression: was mis-hoisted)", () => {
    const r = extractConstantReturn(
      parseModule(`export default () => { if (x) return { a: 1 }; return { b: 2 }; };`).ast,
    );
    expect(r).toEqual({ ok: false });
  });

  it("rejects conditional-only-return handlers (regression: was mis-hoisted)", () => {
    const r = extractConstantReturn(
      parseModule(`export default () => { if (x) return { a: 1 }; };`).ast,
    );
    expect(r).toEqual({ ok: false });
  });

  it("rejects multiple statements even when the last is a return", () => {
    const r = extractConstantReturn(
      parseModule(`export default () => { const x = 1; return x; };`).ast,
    );
    expect(r).toEqual({ ok: false });
  });

  it("treats an empty block as undefined (never a hoistable constant)", () => {
    const r = extractConstantReturn(parseModule(`export default () => {};`).ast);
    expect(r).toEqual(expect.objectContaining({ ok: true, value: undefined }));
  });

  it("returns undefined for non-handler modules", () => {
    const r = extractConstantReturn(parseModule(`export const config = { cache: 1 };`).ast);
    expect(r).toEqual(expect.objectContaining({ ok: true, value: undefined }));
  });
});

// ---------------------------------------------------------------------------
// Response-type inference
// ---------------------------------------------------------------------------

describe("inferResponseTypeAST", () => {
  it("infers json / text / html / stream", () => {
    expect(inferResponseTypeAST(parseModule(`export default () => ctx.json({});`).ast)).toBe(
      "json",
    );
    expect(inferResponseTypeAST(parseModule(`export default () => ctx.text("x");`).ast)).toBe(
      "text",
    );
    expect(
      inferResponseTypeAST(parseModule(`export default () => ctx.html("<b>x</b>");`).ast),
    ).toBe("html");
    expect(
      inferResponseTypeAST(
        parseModule(`export default () => ctx.stream(new ReadableStream());`).ast,
      ),
    ).toBe("stream");
  });

  it("falls back to text for string-literal returns", () => {
    expect(inferResponseTypeAST(parseModule(`export default () => { return "hi"; };`).ast)).toBe(
      "text",
    );
  });

  it("returns unknown for object returns", () => {
    expect(inferResponseTypeAST(parseModule(`export default () => ({ a: 1 });`).ast)).toBe(
      "unknown",
    );
  });
});

// ---------------------------------------------------------------------------
// Schema / config export detection
// ---------------------------------------------------------------------------

describe("hasSchemaExportAST", () => {
  it("detects a named `schema` export", () => {
    const src = `export const schema = { type: "object" };\nexport default () => 1;`;
    expect(hasSchemaExportAST(parseModule(src).ast)).toBe(true);
  });

  it("detects schema-first default wrapper (non-literal second arg)", () => {
    const src = `export default get(() => ({}), { query: { type: "object" } });`;
    expect(hasSchemaExportAST(parseModule(src).ast)).toBe(true);
  });

  it("detects schema-first named wrapper", () => {
    const src = `export const httpGet = get(() => ({}), { query: { type: "object" } });`;
    expect(hasSchemaExportAST(parseModule(src).ast)).toBe(true);
  });

  it("ignores literal / string second arguments", () => {
    expect(hasSchemaExportAST(parseModule(`export default get(() => ({}), "literal");`).ast)).toBe(
      false,
    );
    expect(hasSchemaExportAST(parseModule(`export default get(() => ({}), 42);`).ast)).toBe(false);
  });

  it("returns false when no schema is exported", () => {
    expect(hasSchemaExportAST(parseModule(`export default () => 1;`).ast)).toBe(false);
  });
});

describe("hasConfigExportAST", () => {
  it("detects a named `config` export", () => {
    expect(hasConfigExportAST(parseModule(`export const config = { cache: 60 };`).ast)).toBe(true);
  });

  it("returns false without a config", () => {
    expect(hasConfigExportAST(parseModule(`export default () => 1;`).ast)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Route config extraction
// ---------------------------------------------------------------------------

describe("extractRouteConfigAST", () => {
  it("evaluates a static config object", () => {
    const src = `export const config = { cache: 60, hooks: ["auth"] };\nexport default () => 1;`;
    const parsed = parseModule(src);
    expect(parsed.config).toEqual({ cache: 60, hooks: ["auth"] });
  });

  it("extracts config directly from source + ast", () => {
    const src = `export const config = { cache: 30 };\nexport default () => 1;`;
    const parsed = parseModule(src);
    expect(extractRouteConfigAST(src, parsed.ast)).toEqual({ cache: 30 });
  });

  it("returns undefined when config is absent", () => {
    const parsed = parseModule(`export default () => 1;`);
    expect(parsed.config).toBeUndefined();
  });

  it("warns and returns undefined for a non-evaluable config", () => {
    const dc = new DiagnosticCollector();
    const src = `export const config = { cache: Math.random() };\nexport default () => 1;`;
    const parsed = parseModule(src, dc);

    expect(parsed.config).toBeUndefined();
    expect(dc.warnings.some((w) => w.code === "IGN_CONFIG_EVAL_FAILED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parse bridge + memoization
// ---------------------------------------------------------------------------

describe("parseModule / memoization", () => {
  it("memoizes by content (same reference for repeated parses)", () => {
    const src = `export default () => "same";`;
    const a = parseModule(src);
    const b = parseModule(src);
    expect(a).toBe(b);
  });

  it("clearParseCache forces a fresh parse", () => {
    const src = `export default () => "fresh";`;
    const a = parseModule(src);
    clearParseCache();
    const b = parseModule(src);
    expect(a).not.toBe(b);
    expect(b.handler?.body).toContain("fresh");
  });

  it("estimateNodeCount returns a positive count", () => {
    const count = estimateNodeCount(`export default () => ({ a: 1 });`);
    expect(count).toBeGreaterThan(0);
    expect(Number.isInteger(count)).toBe(true);
  });

  it("estimateNodeCount never throws on malformed input", () => {
    expect(() => estimateNodeCount("export default (((")).not.toThrow();
  });

  it("returns an empty Program and emits a diagnostic for malformed source", () => {
    const dc = new DiagnosticCollector();
    const parsed = parseModule("export default (((", dc);

    expect(parsed.ast.type).toBe("Program");
    expect(parsed.ast.body).toEqual([]);
    expect(parsed.handler).toBeNull();
    expect(dc.warnings.some((w) => w.code === "IGN_PARSE_ERROR")).toBe(true);
  });

  it("returns an empty parse for non-string input", () => {
    const parsed = parseModule(undefined as unknown as string);
    expect(parsed.ast.type).toBe("Program");
    expect(parsed.handler).toBeNull();
    expect(parsed.hasHandlerExport).toBe(false);
  });

  it("handles TypeScript syntax (type annotations, generics)", () => {
    const parsed = parseModule(
      `interface Foo { a: string }\nexport default (ctx: any): Foo => ({ a: ctx.query.q as string });\n`,
    );
    expect(parsed.hasDefaultExport).toBe(true);
    expect(parsed.handler).not.toBeNull();
  });

  it("rejects nothing for plain objects / empty source", () => {
    expect(parseModule("").handler).toBeNull();
    expect(parseModule("\n\n").ast.type).toBe("Program");
  });
});
