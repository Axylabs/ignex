/**
 * @fileoverview Parse result model shared across the parse pipeline.
 */

import type { ExportInfo, ImportInfo, RouteGuards, SymbolInfo } from "../../../types";
import type { Program } from "../ast-types";
import type { ExtractedHandler } from "../types";

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
  /** Default export is a wrapper call (may attach route-local hooks). */
  readonly wrappedHandler: boolean;
  readonly handler: ExtractedHandler | null;
  readonly config?: Record<string, unknown>;
  /** RBAC guards from a `withGuards(handler, guards)` route wrapper. */
  readonly guards?: RouteGuards;
}
