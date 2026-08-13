/**
 * @fileoverview `utils/ast/parse` — parser bridge + memoization + ParseResult.
 *
 * Modules: bridge (synchronous parser fallback chain), cache (content-keyed
 * memoization), scan (single-pass export classification), module (the rich
 * `parseModule` entry point + pure helpers), types (ParseResult). The folder
 * layout is an internal implementation detail; consumers keep importing
 * `../utils/ast/parse` (or the ast barrel) — both resolve to this barrel.
 */

export { clearParseCache } from "./cache";
export {
  estimateNodeCount,
  handlerBodyReferencesImports,
  handlerBodyReferencesModuleScope,
  importedLocalNames,
  isPlainJavaScriptBody,
  parseModule,
} from "./module";
export { hasConfigExportAST, hasSchemaExportAST } from "./scan";
export type { ParseResult } from "./types";
