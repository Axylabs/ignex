/**
 * @fileoverview Source frontend: first-class source file abstraction.
 *
 * Standard compilers parse each input file exactly once and keep the result
 * as a first-class object that every later phase consumes. `SourceFile` is
 * that object: it carries the raw source, the retained AST, and every
 * classification/analysis fact derived from that single parse (imports,
 * exports, symbols, route-handler extraction, schema/config flags).
 *
 * Consumers read `SourceFile.ast` / `SourceFile.handler` directly instead of
 * re-parsing `content` (the old pattern re-parsed each file up to 5× per
 * build). `ModuleInfo` is a deprecated alias for back-compat.
 */

import type { ExportInfo, ImportInfo, RouteGuards, SymbolInfo } from "../types";
import type { Program } from "../utils/ast/ast-types";
import type { ParseResult } from "../utils/ast/parse";
import type { ExtractedHandler } from "../utils/ast/types";

/**
 * A route-module source file, parsed once at discovery and retained for the
 * whole build. Superset of the legacy `ModuleInfo`, adding the kept AST and
 * the extracted route handler so downstream phases never re-parse source.
 */
export interface SourceFile {
  /** Absolute path on disk. */
  readonly path: string;
  /** Workspace-relative path (route table + diagnostics). */
  readonly relPath: string;
  /** Raw file content. */
  readonly content: string;
  /** The single parse this source was derived from (fresh or disk-rehydrated). */
  readonly parse: ParseResult;
  /** Retained AST from the single discovery-time parse. */
  readonly ast: Program;
  readonly imports: readonly ImportInfo[];
  readonly exports: readonly ExportInfo[];
  readonly symbols: readonly SymbolInfo[];
  readonly hasDefaultExport: boolean;
  /** Module exports a route handler (default or named) — participates in the route graph. */
  readonly hasHandlerExport: boolean;
  /** Named export identifier to import when the handler cannot be inlined. */
  readonly handlerExportName?: string;
  readonly schemaExport: boolean;
  readonly configExport: boolean;
  /** Default export is a wrapper call (may attach route-local hooks). */
  readonly wrappedHandler: boolean;
  /** The route schema declares route-local `before`/`after` chains. */
  readonly localHooks: boolean;
  /** Extracted route handler (default or named export), if any. */
  readonly handler: ExtractedHandler | null;
  /** Route-level `config` export, if present. */
  readonly config?: Record<string, unknown>;
  /** RBAC guards from a `withGuards(handler, guards)` route wrapper. */
  readonly guards?: RouteGuards;
}
