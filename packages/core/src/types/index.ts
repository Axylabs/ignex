/**
 * @fileoverview Unified type system — the cross-cutting umbrella.
 *
 * Domain-specific types are grouped by use case so each stays co-located with
 * the feature it belongs to:
 *
 *   ./http       — request/response, schema, cookies, websocket types
 *   ./lifecycle  — hook containers, lifecycle stores, decoration shapes
 *
 * This umbrella re-exports everything so existing `from "../types"` imports
 * keep working unchanged.
 */

import type { ContextUsage } from "@ignus/shared";
import { EMPTY_USAGE, FULL_USAGE } from "@ignus/shared";

export * from "./http";
export * from "./lifecycle";
export type { ContextUsage };
export { EMPTY_USAGE, FULL_USAGE };
