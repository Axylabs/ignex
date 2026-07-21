/**
 * @fileoverview Bun.Transpiler-based AST Parser
 * Replaces regex hacks with a proper ESTree walker.
 * Handles edge cases: nested functions, template literals, comments, re-exports, etc.
 */

import type {
  ContextUsage,
  ImportInfo,
  ExportInfo,
  SymbolInfo,
  Position,
} from "../types";
import { EMPTY_USAGE } from "../../shared/context-usage";
import * as oxcParser from "oxc-parser";

import { createRequire } from "node:module";
/**
 * Build ImportInfo without assigning explicit undefined properties.
 *
 * This satisfies exactOptionalPropertyTypes cleanly.
 */

const createImportInfo = (
  source: string,
  names: string[],
  defaultName?: string,
  namespaceName?: string,
): ImportInfo => {
  const info: {
    source: string;
    names: string[];
    defaultName?: string;
    namespaceName?: string;
  } = {
    source,
    names,
  };

  if (defaultName !== undefined) info.defaultName = defaultName;
  if (namespaceName !== undefined) info.namespaceName = namespaceName;

  return info;
};


// ---------------------------------------------------------------------------
// ESTree Walker — tiny, zero-dependency
// ---------------------------------------------------------------------------

function walk(node: any, cb: (node: any) => void): void {
  if (!node || typeof node !== "object") return;
  cb(node);
  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walk(c, cb);
    } else if (child && typeof child === "object" && child.type) {
      walk(child, cb);
    }
  }
}

function walkUntil<T>(node: any, predicate: (node: any) => T | undefined): T | undefined {
  let result: T | undefined;
  walk(node, (n) => {
    if (result !== undefined) return;
    const r = predicate(n);
    if (r !== undefined) result = r;
  });
  return result;
}

// ---------------------------------------------------------------------------
// Context-Usage Detection
// ---------------------------------------------------------------------------

const CONTEXT_METHODS = new Set([
  "json", "text", "html", "redirect", "stream", "empty", "get", "set",
]);

const CONTEXT_PROPS = new Set([
  "body", "params", "query", "file", "files", "headers", "state", "req", "url",
  "cookie", "server", "set", "sendFile", "proxy", "forward", "cache",
]);

/** Build a map: localVariableName → contextProperty (or "__root__") */
function buildContextMapping(params: any[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const param of params) {
    if (!param) continue;
    if (param.type === "Identifier") {
      map.set(param.name, "__root__");
    } else if (param.type === "ObjectPattern") {
      for (const prop of param.properties || []) {
        if (prop.type !== "Property") continue;
        const key = prop.key?.name ?? prop.key?.value;
        const local = prop.value?.name ?? prop.value?.value;
        if (key && local) map.set(local, key);
        // Nested destructuring not supported for DX simplicity
      }
    }
  }
  return map;
}

function detectUsage(bodyNode: any, mapping: Map<string, string>): ContextUsage {
  const usage: ContextUsage = { ...EMPTY_USAGE };

  walk(bodyNode, (n) => {
    if (n.type === "MemberExpression" && !n.computed && n.object?.type === "Identifier") {
      const root = mapping.get(n.object.name);

      if (root === "__root__") {
        const prop = n.property.name;

        if (prop === "body" || prop === "files") usage.body = true;
        if (prop === "file") usage.file = true;
        if (prop === "params") usage.params = true;
        if (prop === "query") usage.query = true;
        if (prop === "headers") usage.headers = true;
        if (prop === "state" || prop === "getState" || prop === "setState") usage.state = true;
        if (prop === "req") usage.req = true;
        if (prop === "url" || prop === "path" || prop === "method") usage.url = true;

        if (prop === "cookie") usage.cookie = true;
        if (prop === "server") usage.server = true;
        if (prop === "set") usage.set = true;

        if (prop === "json") usage.json = true;
        if (prop === "text") usage.text = true;
        if (prop === "html") usage.html = true;
        if (prop === "redirect") usage.redirect = true;
        if (prop === "stream") usage.stream = true;
        if (prop === "empty") usage.empty = true;
        if (prop === "status") usage.status = true;

        if (prop === "sendFile") usage.sendFile = true;
        if (prop === "proxy") usage.proxy = true;
        if (prop === "forward") usage.forward = true;
        if (prop === "cache") usage.cache = true;
      }
    }

    if (n.type === "Identifier" && mapping.has(n.name)) {
      const prop = mapping.get(n.name)!;

      if (prop === "body" || prop === "files") usage.body = true;
      if (prop === "file") usage.file = true;
      if (prop === "params") usage.params = true;
      if (prop === "query") usage.query = true;
      if (prop === "headers") usage.headers = true;
      if (prop === "state") usage.state = true;
      if (prop === "req") usage.req = true;
      if (prop === "url") usage.url = true;

      if (prop === "cookie") usage.cookie = true;
      if (prop === "server") usage.server = true;
      if (prop === "set") usage.set = true;

      if (prop === "sendFile") usage.sendFile = true;
      if (prop === "proxy") usage.proxy = true;
      if (prop === "forward") usage.forward = true;
      if (prop === "cache") usage.cache = true;
    }
  });

  return usage;
}

// ---------------------------------------------------------------------------
// Handler Extraction
// ---------------------------------------------------------------------------

const HTTP_WRAPPERS = new Set(["get", "post", "put", "patch", "del", "all"]);
const nodeStart = (node: any): number | undefined =>
  node?.range?.[0] ?? node?.start ?? node?.span?.[0];

const nodeEnd = (node: any): number | undefined =>
  node?.range?.[1] ?? node?.end ?? node?.span?.[1];

function extractHandlerFunction(node: any): { fn: any; isAsync: boolean } | null {
  // export default get(async (ctx) => ...)
  if (node.type === "CallExpression" && node.callee?.type === "Identifier" && HTTP_WRAPPERS.has(node.callee.name)) {
    const arg = node.arguments?.[0];
    if (!arg) return null;
    if (arg.type === "ArrowFunctionExpression" || arg.type === "FunctionExpression") {
      return { fn: arg, isAsync: arg.async ?? false };
    }
    // export default get(myHandler)
    if (arg.type === "Identifier") {
      // We can't inline a referenced handler — return null to signal "imported"
      return null;
    }
  }
  // export default (ctx) => ...
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    return { fn: node, isAsync: node.async ?? false };
  }
  // export default async function(ctx) { ... }
  if (node.type === "FunctionDeclaration") {
    return { fn: node, isAsync: node.async ?? false };
  }
  return null;
}

export interface ExtractedHandler {
  readonly body: string;        // source slice of function body
  readonly isAsync: boolean;
  readonly paramName: string;  // first param identifier name (or "ctx" fallback)
  readonly usage: ContextUsage;
}

export function extractHandler(source: string, ast: any): ExtractedHandler | null {
  const defaultExport = walkUntil<any>(ast, (n) =>
    n.type === "ExportDefaultDeclaration" ? n : undefined
  );

  if (!defaultExport) return null;

  const extracted = extractHandlerFunction(defaultExport.declaration);
  if (!extracted) return null;

  const { fn, isAsync } = extracted;
  const params = fn.params || [];
  const mapping = buildContextMapping(params);
  const rootParam = params[0]?.type === "Identifier" ? params[0].name : "ctx";

  let bodyText = "";
  const body = fn.body;

  if (body) {
    const start = nodeStart(body);
    const end = nodeEnd(body);

    if (start != null && end != null) {
      if (body.type === "BlockStatement") {
        bodyText = source.slice(start + 1, end - 1).trim();
      } else {
        bodyText = `return ${source.slice(start, end).trim()};`;
      }
    }
  }

  const usage = detectUsage(body || fn, mapping);

  return {
    body: bodyText,
    isAsync,
    paramName: rootParam,
    usage,
  };
}
// ---------------------------------------------------------------------------
// Import / Export / Symbol Extraction (AST-based, zero regex)
// ---------------------------------------------------------------------------

export function extractImportsAST(ast: any): ImportInfo[] {
  const imports: ImportInfo[] = [];

  walk(ast, (n) => {
    if (n.type !== "ImportDeclaration") return;

    const source = n.source?.value as string;
    if (!source) return;

    const names: string[] = [];
    let defaultName: string | undefined;
    let namespaceName: string | undefined;

    for (const spec of n.specifiers || []) {
      if (spec.type === "ImportDefaultSpecifier") defaultName = spec.local.name;
      if (spec.type === "ImportNamespaceSpecifier") namespaceName = spec.local.name;
      if (spec.type === "ImportSpecifier") names.push(spec.local.name);
    }

    imports.push(createImportInfo(source, names, defaultName, namespaceName));
  });

  return imports;
}

export function extractExportsAST(ast: any): ExportInfo[] {
  const exports: ExportInfo[] = [];
  walk(ast, (n) => {
    if (n.type === "ExportDefaultDeclaration") {
      const name = n.declaration?.name || "default";
      exports.push({ name, kind: "default" });
    }
    if (n.type === "ExportNamedDeclaration") {
      for (const spec of n.specifiers || []) {
        if (spec.type === "ExportSpecifier") {
          exports.push({ name: spec.local.name, kind: "named" });
        }
      }
      for (const decl of n.declaration ? [n.declaration] : []) {
        if (decl.type === "FunctionDeclaration" || decl.type === "VariableDeclaration") {
          const id = decl.id || decl.declarations?.[0]?.id;
          if (id?.name) exports.push({ name: id.name, kind: "named" });
        }
      }
    }
  });
  return exports;
}

function posFromNode(source: string, node: any): Position {
  if (node.loc) return { line: node.loc.start.line, column: node.loc.start.column };
  return { line: 0, column: 0 };
}

export function extractSymbolsAST(source: string, ast: any): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  walk(ast, (n) => {
    if (n.type === "FunctionDeclaration" && n.id?.name) {
      symbols.push({
        name: n.id.name,
        kind: "function",
        pos: posFromNode(source, n),
        isAsync: n.async ?? false,
        isDefaultExport: false,
        params: (n.params || []).map((p: any) => p.name || "..."),
        decorators: [],
        calls: [],
        calledBy: [],
        size: n.range ? n.range[1] - n.range[0] : 9999,
        hotness: 0,
      });
    }
    if (n.type === "VariableDeclaration") {
      for (const decl of n.declarations || []) {
        if (decl.id?.name && decl.init?.type === "ArrowFunctionExpression") {
          symbols.push({
            name: decl.id.name,
            kind: "const",
            pos: posFromNode(source, n),
            isAsync: decl.init.async ?? false,
            isDefaultExport: false,
            params: (decl.init.params || []).map((p: any) => p.name || "..."),
            decorators: [],
            calls: [],
            calledBy: [],
            size: n.range ? n.range[1] - n.range[0] : 9999,
            hotness: 0,
          });
        }
      }
    }
  });
  return symbols;
}

export function hasDefaultExportAST(ast: any): boolean {
  return walkUntil(ast, (n) => (n.type === "ExportDefaultDeclaration" ? true : undefined)) ?? false;
}

export function hasSchemaExportAST(ast: any): boolean {
  let found = false;
  walk(ast, (n) => {
    if (n.type === "ExportNamedDeclaration" && n.declaration?.type === "VariableDeclaration") {
      for (const d of n.declaration.declarations || []) {
        if (d.id?.name === "schema") found = true;
      }
    }
    if (n.type === "ExportSpecifier" && n.local?.name === "schema") found = true;

    // Schema-first HTTP: export default get(handler, { ... })
    if (
      n.type === "ExportDefaultDeclaration" &&
      n.declaration?.type === "CallExpression" &&
      n.declaration.callee?.type === "Identifier" &&
      HTTP_WRAPPERS.has(n.declaration.callee.name)
    ) {
      const args = n.declaration.arguments || [];
      const schemaArg = args[1];

      if (
        schemaArg &&
        schemaArg.type !== "Literal" &&
        schemaArg.type !== "StringLiteral" &&
        schemaArg.type !== "TemplateLiteral"
      ) {
        found = true;
      }
    }
  });
  return found;
}

export function hasConfigExportAST(ast: any): boolean {
  let found = false;
  walk(ast, (n) => {
    if (n.type === "ExportNamedDeclaration" && n.declaration?.type === "VariableDeclaration") {
      for (const d of n.declaration.declarations || []) {
        if (d.id?.name === "config") found = true;
      }
    }
    if (n.type === "ExportSpecifier" && n.local?.name === "config") found = true;
  });
  return found;
}

// ---------------------------------------------------------------------------
// Purity Analysis (AST-based)
// ---------------------------------------------------------------------------

const IMPURE_GLOBALS = new Set([
  "fetch", "Date", "Math", "console", "process", "crypto",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "Promise", "Map", "Set", "WeakMap", "WeakSet",
]);

const IMPURE_CALLS = new Set([
  "Math.random", "Date.now", "crypto.randomUUID", "crypto.getRandomValues",
  "console.log", "console.warn", "console.error", "fetch",
]);

export function isPureBodyAST(ast: any): boolean {
  let impure = false;
  walk(ast, (n) => {
    if (impure) return;
    // new Date(), new Map(), etc.
    if (n.type === "NewExpression" && n.callee?.type === "Identifier" && IMPURE_GLOBALS.has(n.callee.name)) {
      impure = true;
    }
    // fetch(), Math.random(), etc.
    if (n.type === "CallExpression") {
      const callee = n.callee;
      if (callee.type === "Identifier" && IMPURE_GLOBALS.has(callee.name)) {
        impure = true;
      }
      if (callee.type === "MemberExpression") {
        const chain = flattenMember(callee);
        if (chain && IMPURE_CALLS.has(chain)) impure = true;
      }
    }
    // await
    if (n.type === "AwaitExpression") {
      // Conservative: any await is impure (could be DB, fetch, etc.)
      impure = true;
    }
  });
  return !impure;
}

function flattenMember(node: any): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed) {
    const obj = flattenMember(node.object);
    const prop = node.property?.name;
    if (obj && prop) return `${obj}.${prop}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response-Type Inference (AST-based)
// ---------------------------------------------------------------------------

export function inferResponseTypeAST(ast: any): "json" | "text" | "html" | "stream" | "unknown" {
  let type: "json" | "text" | "html" | "stream" | "unknown" = "unknown";
  walk(ast, (n) => {
    if (n.type === "CallExpression" && n.callee?.type === "MemberExpression") {
      const chain = flattenMember(n.callee);
      if (chain === "ctx.json") type = "json";
      if (chain === "ctx.text") type = "text";
      if (chain === "ctx.html") type = "html";
      if (chain === "ctx.stream") type = "stream";
    }
    // Heuristic: return "string" or template literal → text
    if (n.type === "ReturnStatement" && n.argument?.type === "Literal" && typeof n.argument.value === "string") {
      if (type === "unknown") type = "text";
    }
  });
  return type;
}

// ---------------------------------------------------------------------------
// Main Parse Entry
// ---------------------------------------------------------------------------

export interface ParseResult {
  readonly ast: any;
  readonly imports: ImportInfo[];
  readonly exports: ExportInfo[];
  readonly symbols: SymbolInfo[];
  readonly hasDefaultExport: boolean;
  readonly schemaExport: boolean;
  readonly configExport: boolean;
  readonly handler: ExtractedHandler | null;
  readonly config?: any;
}

// ---------------------------------------------------------------------------
// AST Parser Bridge
// ---------------------------------------------------------------------------

function normalizeAst(result: any): any {
  if (!result) {
    return { type: "Program", body: [] };
  }

  if (result.errors && result.errors.length > 0) {
    throw new Error(result.errors[0]?.message ?? "AST parse error");
  }

  const ast = result.program ?? result.ast ?? result.root ?? result;

  if (!ast.type) ast.type = "Program";
  if (!Array.isArray(ast.body)) ast.body = [];

  return ast;
}

function tryOxcParser(source: string): any | undefined {
  const mod = oxcParser as any;
  const parseSync = mod.parseSync ?? mod.default?.parseSync;

  if (typeof parseSync !== "function") return undefined;

  const attempts = [
    () =>
      parseSync("flux.ts", source, {
        sourceType: "module",
        target: "esnext",
      }),
    () =>
      parseSync(source, {
        sourceType: "module",
        target: "esnext",
      }),
  ];

  for (const attempt of attempts) {
    try {
      const result = attempt();

      if (result && typeof result.then === "function") continue;
      if (result?.errors?.length) continue;

      const program = result?.program ?? result?.ast ?? result;

      if (program?.type || Array.isArray(program?.body)) {
        return program;
      }
    } catch {
      // try next shape
    }
  }

  return undefined;
}

function parseToAst(source: string): any {
  const oxc = tryOxcParser(source);
  if (oxc) return normalizeAst(oxc);

  const B: any = Bun;

  const parsers: Array<() => any> = [
    () =>
      typeof B.parse === "function"
        ? B.parse(source, {
            loader: "ts",
            target: "bun",
            ranges: true,
            loc: true,
          })
        : undefined,

    () =>
      typeof B.parseSync === "function"
        ? B.parseSync(source, {
            loader: "ts",
            target: "bun",
            ranges: true,
            loc: true,
          })
        : undefined,

    () => {
      const transpiler = B.Transpiler
        ? new B.Transpiler({ loader: "ts", target: "bun" })
        : undefined;

      return transpiler && typeof transpiler.parse === "function"
        ? transpiler.parse(source, { ranges: true, loc: true })
        : undefined;
    },

    () => {
      const transpiler = B.Transpiler
        ? new B.Transpiler({ loader: "ts", target: "bun" })
        : undefined;

      return transpiler && typeof transpiler.parseSync === "function"
        ? transpiler.parseSync(source, { ranges: true, loc: true })
        : undefined;
    },
  ];

  for (const parser of parsers) {
    try {
      const result = parser();

      if (result && typeof result.then === "function") continue;

      if (result) {
        return normalizeAst(result);
      }
    } catch {
      // try next parser
    }
  }

  throw new Error(
    "No synchronous JS/TS AST parser available. Install oxc-parser or use a Bun version with Bun.parse/Bun.parseSync."
  );
}

export function estimateNodeCount(source: string): number {
  try {
    const ast = parseToAst(source);
    let count = 0;

    walk(ast, () => {
      count++;
    });

    return count;
  } catch {
    // Heuristic fallback.
    return Math.max(1, Math.ceil(source.length / 20));
  }
}

export function parseModule(source: string): ParseResult {
  let ast: any;

  try {
    ast = parseToAst(source);
  } catch {
    ast = { type: "Program", body: [] };
  }

return {
  ast,
  imports: extractImportsAST(ast),
  exports: extractExportsAST(ast),
  symbols: extractSymbolsAST(source, ast),
  hasDefaultExport: hasDefaultExportAST(ast),
  schemaExport: hasSchemaExportAST(ast),
  configExport: hasConfigExportAST(ast),
  handler: extractHandler(source, ast),
  config: extractRouteConfigAST(source, ast),
};
}

export function extractRouteConfigAST(source: string, ast: any): any | undefined {
  let configDecl: any;

  walk(ast, (n) => {
    if (configDecl) return;

    if (
      n.type === "ExportNamedDeclaration" &&
      n.declaration?.type === "VariableDeclaration"
    ) {
      for (const d of n.declaration.declarations || []) {
        if (d.id?.name === "config" && d.init) {
          configDecl = d;
        }
      }
    }
  });

  if (!configDecl?.init) return undefined;

  const start = nodeStart(configDecl.init);
  const end = nodeEnd(configDecl.init);

  if (start == null || end == null) return undefined;

  const code = source.slice(start, end);

  try {
    return new Function(`"use strict"; return (${code});`)();
  } catch {
    return undefined;
  }
}