/**
 * @fileoverview AST parser bridge + parse memoization.
 *
 * Turns raw module source into a parsed {@link ParseResult} once, then serves
 * the same result from a bounded content-keyed cache — the same module is
 * parsed up to 5× per build (discovery, analysis, constant-response
 * detection, inlining eligibility, inline-candidate extraction) and every
 * extracted field is a pure function of `source`.
 *
 * Parser fallback chain (first synchronous parser that succeeds wins):
 * `oxc-parser` → `Bun.parse` → `Bun.parseSync` → `Bun.Transpiler.parse` →
 * `Bun.Transpiler.parseSync`. When every parser fails, an empty `Program` is
 * returned alongside a parse diagnostic so downstream phases degrade safely.
 */

import * as oxcParser from "oxc-parser";
import {
  DiagnosticCodes,
  type DiagnosticCollector,
  errorMessage,
  getCodeFrame,
} from "../../diagnostics";
import type { ExportInfo, ImportInfo, ModuleInfo, SymbolInfo } from "../../types";
import { bindingName, type Node, type Program } from "./ast-types";
import { extractRouteConfigAST } from "./config";
import { extractHandlerExport, extractHandlerExportName, isHandlerInitNode } from "./handler";
import { extractExportsAST, extractImportsAST } from "./imports";
import { extractSymbolsAST } from "./symbols";
import type { ExtractedHandler } from "./types";
import { walk, walkSome } from "./walk";

export interface ParseResult {
  readonly ast: Program;
  readonly imports: ImportInfo[];
  readonly exports: ExportInfo[];
  readonly symbols: SymbolInfo[];
  readonly hasDefaultExport: boolean;
  readonly hasHandlerExport: boolean;
  /** Named export identifier to import when the handler cannot be inlined. */
  readonly handlerExportName?: string;
  readonly schemaExport: boolean;
  readonly configExport: boolean;
  readonly handler: ExtractedHandler | null;
  readonly config?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Content-Keyed Parse Memoization
// ---------------------------------------------------------------------------

const PARSE_CACHE_MAX = 512;
const parseCache = new Map<string, ParseResult>();

const cacheParse = (key: string, result: ParseResult): ParseResult => {
  parseCache.set(key, result);
  if (parseCache.size > PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  return result;
};

/** Clear the in-process parse cache (mostly for tests / watch restarts). */
export const clearParseCache = (): void => {
  parseCache.clear();
};

// ---------------------------------------------------------------------------
// Parser Bridge
// ---------------------------------------------------------------------------

/** Normalize any parser return shape into a usable Program node. */
function normalizeAst(result: unknown): Program {
  if (!result) return { type: "Program", body: [] };

  const withErrors = result as { errors?: Array<{ message?: string }> };
  if (withErrors.errors && withErrors.errors.length > 0) {
    throw new Error(withErrors.errors[0]?.message ?? "AST parse error");
  }

  // The one parser-specific cast in the AST layer: parser return shapes are
  // structurally untyped, so we trust the Program-shaped result at the
  // boundary and use the typed model everywhere downstream.
  const container = result as Record<string, unknown>;
  const ast = (container.program ?? container.ast ?? container.root ?? result) as {
    type?: string;
    body?: unknown;
  };

  if (!ast.type) ast.type = "Program";
  if (!Array.isArray(ast.body)) ast.body = [];

  return ast as unknown as Program;
}

function tryOxcParser(source: string): unknown | undefined {
  const mod = oxcParser as unknown as {
    parseSync?: (arg0: unknown, arg1?: unknown, arg2?: unknown) => unknown;
  };
  const parseSync = mod.parseSync;

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
      const result = attempt() as {
        then?: unknown;
        errors?: Array<{ message?: string }>;
        program?: unknown;
        ast?: unknown;
      } | null;

      if (result && typeof result.then === "function") continue;
      if (result?.errors?.length) continue;

      const program = result?.program ?? result?.ast ?? result;

      if (program && typeof program === "object") {
        const p = program as { type?: unknown; body?: unknown };
        if (p.type || Array.isArray(p.body)) return program;
      }
    } catch {
      // try next shape
    }
  }

  return undefined;
}

function parseToAst(source: string): Program {
  const oxc = tryOxcParser(source);
  if (oxc) return normalizeAst(oxc);

  // Access Bun via globalThis so this module also typechecks under
  // non-Bun tsconfigs (e.g. the CLI's `types: ["node"]`). At runtime this is
  // undefined outside Bun, and each access below guards with `typeof`.
  const B: any = (globalThis as any).Bun;

  const parsers: Array<() => unknown> = [
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
      const result = parser() as { then?: unknown } | undefined;
      if (result && typeof result.then === "function") continue;
      if (result) return normalizeAst(result);
    } catch {
      // try next parser
    }
  }

  throw new Error(
    "No synchronous JS/TS AST parser available. Install oxc-parser or use a Bun version with Bun.parse/Bun.parseSync.",
  );
}

// ---------------------------------------------------------------------------
// Export classification (single-pass, early-terminating)
// ---------------------------------------------------------------------------

/** Whether a schema argument is "real" (not a string literal placeholder). */
const isSchemaArg = (arg: Node | null | undefined): boolean =>
  !!arg && arg.type !== "Literal" && arg.type !== "StringLiteral" && arg.type !== "TemplateLiteral";

/** True when a named export initializer is a schema-first HTTP wrapper call. */
const hasSchemaSecondArg = (init: Node | null | undefined): boolean => {
  if (
    init?.type === "CallExpression" &&
    init.callee?.type === "Identifier" &&
    isHandlerInitNode(init) // wrapper call (get/post/…)
  ) {
    return isSchemaArg(init.arguments?.[1]);
  }
  return false;
};

/**
 * True when the module exports a `schema` binding (named export or
 * schema-first HTTP wrapper with a non-literal second argument).
 * Kept exported for API compatibility; `scanExportFlags` is the fast path.
 */
export function hasSchemaExportAST(ast: Program): boolean {
  let found = false;
  walk(ast, (n) => {
    if (found) return;

    if (n.type === "ExportNamedDeclaration" && n.declaration?.type === "VariableDeclaration") {
      for (const d of n.declaration.declarations || []) {
        if (bindingName(d.id) === "schema") found = true;
        if (bindingName(d.id) && hasSchemaSecondArg(d.init)) found = true;
      }
    }
    if (n.type === "ExportSpecifier" && n.local?.name === "schema") found = true;

    // Schema-first HTTP default export: `export default get(handler, { … })`.
    if (
      n.type === "ExportDefaultDeclaration" &&
      n.declaration?.type === "CallExpression" &&
      n.declaration.callee?.type === "Identifier" &&
      isHandlerInitNode(n.declaration)
    ) {
      if (isSchemaArg(n.declaration.arguments?.[1])) found = true;
    }
  });
  return found;
}

/** True when the module exports a `config` binding. */
export function hasConfigExportAST(ast: Program): boolean {
  let found = false;
  walk(ast, (n) => {
    if (found) return;
    if (n.type === "ExportNamedDeclaration" && n.declaration?.type === "VariableDeclaration") {
      for (const d of n.declaration.declarations || []) {
        if (bindingName(d.id) === "config") found = true;
      }
    }
    if (n.type === "ExportSpecifier" && n.local?.name === "config") found = true;
  });
  return found;
}

interface ExportFlags {
  hasDefaultExport: boolean;
  hasHandlerExport: boolean;
  schemaExport: boolean;
  configExport: boolean;
}

/**
 * Resolve every route-module classification flag in a single early-terminating
 * walk. `walkSome` stops the instant all four flags are decided, so modules
 * that export everything (or nothing) are classified after a partial walk.
 */
const scanExportFlags = (ast: Program): ExportFlags => {
  const flags: ExportFlags = {
    hasDefaultExport: false,
    hasHandlerExport: false,
    schemaExport: false,
    configExport: false,
  };

  const done = (): boolean =>
    flags.hasDefaultExport && flags.hasHandlerExport && flags.schemaExport && flags.configExport;

  walkSome(ast, (n) => {
    if (n.type === "ExportDefaultDeclaration") {
      flags.hasDefaultExport = true;
      // Matches `hasHandlerExportAST`: a default export makes a module a
      // route module (route files are expected to default-export a handler).
      flags.hasHandlerExport = true;
      const decl = n.declaration;
      // Schema-first HTTP: `export default get(handler, { … })`.
      if (decl?.type === "CallExpression" && isHandlerInitNode(decl)) {
        if (isSchemaArg(decl.arguments?.[1])) flags.schemaExport = true;
      }
    }

    if (n.type === "ExportNamedDeclaration") {
      if (n.declaration?.type === "VariableDeclaration") {
        for (const d of n.declaration.declarations || []) {
          const name = bindingName(d.id);
          const init = d.init;
          if (!name || !init) continue;
          if (name === "schema") flags.schemaExport = true;
          if (name === "config") flags.configExport = true;
          if (isHandlerInitNode(init)) flags.hasHandlerExport = true;
          if (hasSchemaSecondArg(init)) flags.schemaExport = true;
        }
      } else if (n.declaration?.type === "FunctionDeclaration") {
        flags.hasHandlerExport = true;
      }
      for (const spec of n.specifiers || []) {
        const local = spec.type === "ExportSpecifier" ? spec.local?.name : undefined;
        if (local === "schema") flags.schemaExport = true;
        if (local === "config") flags.configExport = true;
      }
    }

    return done();
  });

  return flags;
};

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Estimate the AST node count for a module (reuses the memoized parse). */
export function estimateNodeCount(source: string): number {
  try {
    const parsed = parseModule(source);
    let count = 0;
    walk(parsed.ast, () => {
      count++;
    });
    return count;
  } catch {
    // Heuristic fallback.
    return Math.max(1, Math.ceil(source.length / 20));
  }
}

/**
 * Collect every local binding introduced by a module's import statements.
 */
export const importedLocalNames = (imports: readonly ImportInfo[]): string[] => {
  const locals: string[] = [];
  for (const imp of imports) {
    locals.push(...imp.names);
    if (imp.defaultName) locals.push(imp.defaultName);
    if (imp.namespaceName) locals.push(imp.namespaceName);
  }
  return locals;
};

/**
 * True when any import's local binding is referenced inside the extracted
 * handler body. Imports that only feed the wrapper call / schema / config
 * (e.g. `export const httpGet = get(...)`) do not block inlining the handler
 * body — the wrapper is dropped and only the body is inlined.
 */
export const handlerBodyReferencesImports = (
  mod: Pick<ModuleInfo, "content" | "imports">,
): boolean => {
  if (mod.imports.length === 0) return false;

  const body = parseModule(mod.content).handler?.body;
  if (!body) return true; // can't prove safe — treat as referenced

  const locals = importedLocalNames(mod.imports);
  if (locals.length === 0) return false;

  const escaped = locals.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`\\b(?:${escaped.join("|")})\\b`);
  return re.test(body);
};

/**
 * True when the given handler body parses as plain JavaScript (wrapped in a
 * function). Used as a fallback gate for handler inlining when a TS→JS
 * transpiler (`Bun.Transpiler`) is unavailable: only plain-JS bodies may be
 * inlined raw into the generated `.js` server, since TS-only syntax (generic
 * type args, annotations, `as` casts) would break the output.
 */
export const isPlainJavaScriptBody = (body: string, isAsync: boolean): boolean => {
  try {
    const mod = oxcParser as unknown as {
      parseSync?: (
        filename: string,
        source: string,
        options?: unknown,
      ) => {
        errors?: unknown[];
      };
    };
    const parseSync = mod.parseSync;
    if (typeof parseSync !== "function") return false;

    const wrapped = `${isAsync ? "async " : ""}function __fluxInline() { ${body} }`;
    const result = parseSync("__flux_inline.js", wrapped, {
      sourceType: "script",
      lang: "js",
    }) as { errors?: unknown[] } | null;

    return !result || (result.errors?.length ?? 0) === 0;
  } catch {
    return false;
  }
};

/**
 * Parse a module source string into a rich {@link ParseResult}, memoized by
 * source content. Never throws for malformed source — it emits a parse
 * diagnostic and returns an empty Program instead.
 */
export function parseModule(source: string, diagnostics?: DiagnosticCollector): ParseResult {
  if (typeof source !== "string") {
    // Defensive: callers must pass source text — return an empty parse rather
    // than crashing the whole build.
    return emptyParseResult();
  }

  const cached = parseCache.get(source);
  if (cached) return cached;

  let ast: Program;

  try {
    ast = parseToAst(source);
  } catch (error) {
    diagnostics?.warn({
      code: DiagnosticCodes.ParseError,
      message: `Failed to parse module: ${errorMessage(error)}`,
      frame: getCodeFrame(source, { line: 1, column: 0 }),
    });
    ast = { type: "Program", body: [] };
  }

  const flags = scanExportFlags(ast);
  const handlerExportName = extractHandlerExportName(ast);
  const routeConfig = extractRouteConfigAST(source, ast, diagnostics);

  return cacheParse(source, {
    ast,
    imports: extractImportsAST(ast),
    exports: extractExportsAST(ast),
    symbols: extractSymbolsAST(source, ast),
    hasDefaultExport: flags.hasDefaultExport,
    hasHandlerExport: flags.hasHandlerExport,
    schemaExport: flags.schemaExport,
    configExport: flags.configExport,
    handler: extractHandlerExport(source, ast),

    ...(routeConfig !== undefined ? { config: routeConfig as Record<string, unknown> } : {}),
    ...(handlerExportName !== undefined ? { handlerExportName } : {}),
  });
}

const emptyParseResult = (): ParseResult => ({
  ast: { type: "Program", body: [] },
  imports: [],
  exports: [],
  symbols: [],
  hasDefaultExport: false,
  hasHandlerExport: false,
  schemaExport: false,
  configExport: false,
  handler: null,
});
