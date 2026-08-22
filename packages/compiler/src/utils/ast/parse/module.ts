/**
 * @fileoverview Parse module — the memoized rich `ParseResult` entry point
 * plus the pure helpers built on top of it (node counting, inlining gates,
 * plain-JS body detection).
 */

import * as oxcParser from "oxc-parser";
import {
  DiagnosticCodes,
  type DiagnosticCollector,
  errorMessage,
  getCodeFrame,
} from "../../../diagnostics";
import type { ImportInfo, ModuleInfo } from "../../../types";
import type { Program } from "../ast-types";
import { extractRouteConfigAST } from "../config";
import { extractHandlerExport, extractHandlerExportName, extractRouteGuardsAST } from "../handler";
import { extractExportsAST, extractImportsAST } from "../imports";
import { collectTopLevelBindingNames, extractSymbolsAST } from "../symbols";
import { walk } from "../walk";
import { parseToAst } from "./bridge";
import { cacheParse, getCachedParse } from "./cache";
import { scanExportFlags } from "./scan";
import type { ParseResult } from "./types";

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
 *
 * Uses the handler retained on the {@link ParseResult} (no re-parse).
 */
export const handlerBodyReferencesImports = (
  mod: Pick<ModuleInfo, "imports" | "handler">,
): boolean => {
  if (mod.imports.length === 0) return false;

  const body = mod.handler?.body;
  if (!body) return true; // can't prove safe — treat as referenced

  const locals = importedLocalNames(mod.imports);
  if (locals.length === 0) return false;

  const escaped = locals.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`\\b(?:${escaped.join("|")})\\b`);
  return re.test(body);
};

/**
 * True when the extracted handler body references a top-level binding declared
 * in its own module (other than the handler itself or imports, which
 * {@link handlerBodyReferencesImports} covers). Inlining drops module scope,
 * so a body closing over a module-level `let`/`const`/function/class would
 * throw `ReferenceError` when embedded into the generated server.
 *
 * Conservative by design: a word-boundary regex match (even a false positive
 * from string content or a shadowed local) only disables inlining — it never
 * produces wrong output.
 */
export const handlerBodyReferencesModuleScope = (
  mod: Pick<ModuleInfo, "ast" | "handler" | "handlerExportName">,
): boolean => {
  const body = mod.handler?.body;
  if (!body) return false;

  const names = collectTopLevelBindingNames(mod.ast);
  const selfName = mod.handlerExportName;
  const others = selfName ? names.filter((n) => n !== selfName) : names;
  if (others.length === 0) return false;

  const escaped = others.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
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

    const wrapped = `${isAsync ? "async " : ""}function __ignexInline() { ${body} }`;
    const result = parseSync("__ignex_inline.js", wrapped, {
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

  const cached = getCachedParse(source);
  if (cached) return cached;

  let ast: Program;

  try {
    ast = parseToAst(source);
  } catch (error) {
    // A route/hook/app-config module that cannot parse is a BUILD ERROR —
    // continuing with an empty program silently drops the route (404 in
    // production). Fail the build with a clear diagnostic instead.
    diagnostics?.error({
      code: DiagnosticCodes.ParseError,
      message: `Failed to parse module: ${errorMessage(error)}`,
      frame: getCodeFrame(source, { line: 1, column: 0 }),
    });
    ast = { type: "Program", body: [] };
  }

  const flags = scanExportFlags(ast);
  const handlerExportName = extractHandlerExportName(ast);
  const routeConfig = extractRouteConfigAST(source, ast, diagnostics);
  const guards = extractRouteGuardsAST(ast);

  return cacheParse(source, {
    ast,
    imports: extractImportsAST(ast),
    exports: extractExportsAST(ast),
    symbols: extractSymbolsAST(source, ast),
    hasDefaultExport: flags.hasDefaultExport,
    hasHandlerExport: flags.hasHandlerExport,
    schemaExport: flags.schemaExport,
    configExport: flags.configExport,
    wrappedHandler: flags.wrappedHandler,
    localHooks: flags.localHooks,
    handler: extractHandlerExport(source, ast),

    ...(guards !== undefined ? { guards } : {}),
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
  wrappedHandler: false,
  localHooks: false,
  handler: null,
});
