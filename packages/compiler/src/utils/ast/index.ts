/**
 * @fileoverview AST utilities — public facade.
 *
 * This module is the single import surface for the compiler's AST analysis
 * layer (usage detection, handler extraction, purity, constants, symbols,
 * parsing). Internally the implementation is split into focused modules under
 * `./` so each concern stays small, but every consumer keeps importing from
 * `../utils/ast` as before.
 *
 * Modules:
 * - {@link ./walk}   — walker primitives (walk / walkUntil / walkSome)
 * - {@link ./usage}  — build-time ctx-usage detection
 * - {@link ./handler}— route handler extraction
 * - {@link ./imports}— import / export extraction
 * - {@link ./symbols}— symbol + intra-module call-graph extraction
 * - {@link ./purity} — purity analysis
 * - {@link ./constant}— safe constant evaluation
 * - {@link ./response}— response-type inference
 * - {@link ./config} — route `config` extraction
 * - {@link ./parse}  — parser bridge + memoization + ParseResult
 */

export { extractRouteConfigAST } from "./config";
export { evaluateConstantNode, extractConstantReturn } from "./constant";
export {
  extractHandlerExport,
  extractHandlerExportName,
  extractHandlerNodeAST,
  hasHandlerExportAST,
} from "./handler";
export { extractExportsAST, extractImportsAST, hasDefaultExportAST } from "./imports";
export {
  clearParseCache,
  estimateNodeCount,
  handlerBodyReferencesImports,
  handlerBodyReferencesModuleScope,
  hasConfigExportAST,
  hasSchemaExportAST,
  isPlainJavaScriptBody,
  type ParseResult,
  parseModule,
} from "./parse";
export { isPureBodyAST } from "./purity";
export {
  findResponseJsonReturn,
  inferResponseTypeAST,
} from "./response";
export { extractSymbolsAST } from "./symbols";
export type { ExtractedHandler } from "./types";
export { nodeEnd, nodeStart, walk, walkSome, walkUntil } from "./walk";
