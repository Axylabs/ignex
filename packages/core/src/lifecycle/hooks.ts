/**
 * @fileoverview Hook Execution Engine v3.0
 * Composable, async middleware with scoped lifecycle.
 */

import type { FluxContext } from "../http/context";
import type { HookContainer } from "../types";

// ============================================================================
// Types
// ============================================================================

export type HookResult =
  | { readonly ok: true; ctx: FluxContext }
  | { readonly ok: false; response: Response };

export type HookFn = (ctx: FluxContext) => Promise<HookResult> | HookResult;

// ============================================================================
// Hook Constructors
// ============================================================================

export const continueHook = (ctx: FluxContext): HookResult => ({ ok: true, ctx });
export const haltHook = (response: Response): HookResult => ({ ok: false, response });

// ============================================================================
// Hook Execution
// ============================================================================

export const executeHooks = async (
  ctx: FluxContext,
  hooks: readonly HookFn[],
): Promise<{ ctx: FluxContext; halted?: Response }> => {
  let current = ctx;
  for (const hook of hooks) {
    const result = await hook(current);
    if (!result.ok) return { ctx: current, halted: result.response };
    current = result.ctx;
  }
  return { ctx: current };
};

// ============================================================================
// Hook Composition
// ============================================================================

export const composeHooks =
  (...hooks: HookFn[]): HookFn =>
  async (ctx) => {
    const result = await executeHooks(ctx, hooks);
    if (result.halted) return haltHook(result.halted);
    return continueHook(result.ctx);
  };

// ============================================================================
// Hook Merging (Pure)
// ============================================================================

export const mergeHookArrays = (
  a: HookContainer[] | undefined,
  b: HookContainer[] | undefined,
): HookContainer[] => {
  // Always return a fresh array so callers' arrays are never aliased (mutating
  // one app's lifecycle must not mutate `EMPTY_LIFECYCLE` or the caller's).
  const base = a ?? [];
  const extra = b ?? [];
  if (base.length === 0 && extra.length === 0) return [];

  const checksums = new Set(base.map((h) => h.checksum).filter(Boolean));
  const merged = [...base];
  for (const hook of extra) {
    if (hook.checksum && checksums.has(hook.checksum)) continue;
    merged.push(hook);
  }
  return merged;
};
