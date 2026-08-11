/**
 * @fileoverview Shared AST-analysis result types.
 *
 * Kept separate from `handler.ts` so the interface can be imported by
 * `parse.ts` and by consumers without pulling in the whole extraction
 * machinery.
 */

import type { ContextUsage } from "@ignus/shared";

/** A route handler extracted from a module's default or named export. */
export interface ExtractedHandler {
  /** Source slice of the function body. */
  readonly body: string;
  readonly isAsync: boolean;
  /** First param identifier name (or "ctx" fallback). */
  readonly paramName: string;
  /** True when the first parameter is a plain identifier (safe to inline). */
  readonly isSimpleParam: boolean;
  readonly usage: ContextUsage;
  /** How the handler is exported from its module. */
  readonly exportKind: "default" | "named";
  /** Export identifier when `exportKind === "named"` (e.g. `httpGet`). */
  readonly exportName?: string;
}
