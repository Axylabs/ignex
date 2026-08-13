/**
 * @fileoverview Hook Execution Engine v3.0
 * Composable, async middleware with scoped lifecycle.
 */

import type { IgnexContext } from "../http/context";
import type { HookContainer, LifeCycleStore } from "../types";

// ============================================================================
// Types
// ============================================================================

/**
 * A hook's outcome: continue the chain (with an updated `ctx`) or halt it
 * with a `Response`.
 */
export type HookResult =
  | { readonly ok: true; ctx: IgnexContext }
  | { readonly ok: false; response: Response };

/** A lifecycle hook: receives the context and returns the next step. */
export type HookFn = (ctx: IgnexContext) => Promise<HookResult> | HookResult;

// ============================================================================
// Hook Constructors
// ============================================================================

/** Continue the hook chain with the given context. */
export const continueHook = (ctx: IgnexContext): HookResult => ({ ok: true, ctx });

/** Halt the hook chain with a response. */
export const haltHook = (response: Response): HookResult => ({ ok: false, response });

// ============================================================================
// Hook Execution
// ============================================================================

/**
 * Run hooks sequentially until one halts.
 *
 * @returns The final context, plus the halting `Response` when the chain stopped.
 */
export const executeHooks = async (
  ctx: IgnexContext,
  hooks: readonly HookFn[],
): Promise<{ ctx: IgnexContext; halted?: Response }> => {
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

/** Compose multiple hooks into a single {@link HookFn} run left-to-right. */
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

/**
 * Merge two hook arrays, de-duplicating by `checksum`.
 *
 * Always returns a fresh array so callers' arrays are never aliased.
 *
 * @param a - Base hooks (win on duplicate checksums).
 * @param b - Extra hooks appended when their checksum is new.
 */
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

// ============================================================================
// Lifecycle Merging (Pure)
// ============================================================================

/** Merge two full lifecycle stores; each stage is `mergeHookArrays`-deduped. */
export const mergeLifeCycle = (a: LifeCycleStore, b: Partial<LifeCycleStore>): LifeCycleStore => ({
  start: mergeHookArrays(a.start, b.start),
  request: mergeHookArrays(a.request, b.request),
  parse: mergeHookArrays(a.parse, b.parse),
  transform: mergeHookArrays(a.transform, b.transform),
  beforeHandle: mergeHookArrays(a.beforeHandle, b.beforeHandle),
  afterHandle: mergeHookArrays(a.afterHandle, b.afterHandle),
  mapResponse: mergeHookArrays(a.mapResponse, b.mapResponse),
  afterResponse: mergeHookArrays(a.afterResponse, b.afterResponse),
  trace: mergeHookArrays(a.trace, b.trace),
  error: mergeHookArrays(a.error, b.error),
  stop: mergeHookArrays(a.stop, b.stop),
});
