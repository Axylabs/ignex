/**
 * @fileoverview Hook Execution Engine v3.0
 * Composable, async middleware with scoped lifecycle.
 */

import type { FluxContext } from "./context";
import type { HookContainer, LifeCycleType } from "./types";

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
  hooks: readonly HookFn[]
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

export const composeHooks = (...hooks: HookFn[]): HookFn =>
  async (ctx) => {
    const result = await executeHooks(ctx, hooks);
    if (result.halted) return haltHook(result.halted);
    return continueHook(result.ctx);
  };

// ============================================================================
// Hook Filtering by Scope
// ============================================================================

export const filterByScope = (scope: LifeCycleType) =>
  (hooks: HookContainer[]): HookContainer[] =>
    hooks.filter(h => !h.scope || h.scope === scope || h.scope === "global");

export const filterGlobal = (hooks: HookContainer[]): HookContainer[] =>
  hooks.filter(h => h.scope === "global" || h.scope === "scoped");

// ============================================================================
// Hook Merging (Pure)
// ============================================================================

export const mergeHookArrays = (
  a: HookContainer[] | undefined,
  b: HookContainer[] | undefined
): HookContainer[] => {
  if (!a && !b) return [];
  if (!a) return b!;
  if (!b) return a;

  const checksums = new Set(a.map(h => h.checksum).filter(Boolean));
  const merged = [...a];
  for (const hook of b) {
    if (hook.checksum && checksums.has(hook.checksum)) continue;
    merged.push(hook);
  }
  return merged;
};

// ============================================================================
// Async Detection
// ============================================================================

export const isAsyncFn = (fn: Function): boolean =>
  fn.constructor.name === "AsyncFunction" ||
  fn.constructor.name === "AsyncGeneratorFunction";

// ============================================================================
// Higher-Order Hook Factories
// ============================================================================

export const withTiming = (name: string, hook: HookFn): HookFn =>
  async (ctx) => {
    const start = performance.now();
    const result = await hook(ctx);
    ctx.setState(`__timing_${name}`, performance.now() - start);
    return result;
  };

export const withErrorBoundary = (fallback: (err: Error) => Response) => (hook: HookFn): HookFn =>
  async (ctx) => {
    try { return await hook(ctx); }
    catch (err) { return haltHook(fallback(err as Error)); }
  };

export const conditional = (predicate: (ctx: FluxContext) => boolean) => (hook: HookFn): HookFn =>
  (ctx) => predicate(ctx) ? hook(ctx) : continueHook(ctx);