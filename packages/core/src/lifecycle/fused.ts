/**
 * @fileoverview Fused lifecycle chains — direct plugin-hook dispatch for
 * compiled servers.
 *
 * `runHooks` (./run.ts) must interpret hooks from many sources (plugins,
 * user lifecycle, legacy callable plugins) through HookContainer wrappers
 * that synthesize a `{ ctx }` result object per call. A COMPILED server that
 * has attributed its whole plugin layer statically can instead compose the
 * plugin hooks DIRECTLY at boot (once) and run them with the narrow
 * interpretation this module implements — the plugin contract itself
 * (`Response` | truthy ctx | `undefined` | Promise). Per-request savings:
 * no container wrapper frame, no synthesized result object, no stage-array
 * walk. `buildFusedChains` mirrors `pluginsToLifeCycle`'s filter/pattern/
 * order decisions exactly, so the two chains are equivalent by construction;
 * the emitting server additionally asserts a boot-time count gate and falls
 * back to `runHooks` on any mismatch.
 */

import type { IgnexContext } from "../http/context";
import { createPatternMatcher, type RoutePattern } from "./plugin";

/** A direct plugin hook in a fused chain: the plugin's own `onRequest`/`onResponse`
 * (or its pattern-wrapped form). `undefined` passes through, a `Response` halts
 * (pre) or replaces (post). */
export type FusedFn = (ctx: IgnexContext, response?: Response) => unknown;

/** Boot-composed direct plugin-hook chains (see {@link buildFusedChains}). */
export interface FusedChains {
  /** Direct onRequest fns in registration order (pattern-wrapped). */
  readonly preParse: readonly FusedFn[];
  /** Direct onResponse fns in REVERSE registration order (pattern-wrapped). */
  readonly post: readonly FusedFn[];
}

/** Outcome of running a fused chain: continue with `ctx`, or halt with a `response`. */
export interface FusedResult {
  ctx: IgnexContext;
  response?: Response;
}

interface PluginLike {
  readonly name: string;
  readonly pattern?: RoutePattern;
  readonly __ignexDevOnly?: boolean;
  readonly onRequest?: FusedFn;
  readonly onResponse?: (ctx: IgnexContext, response: Response) => unknown;
}

const isPluginLike = (v: unknown): v is PluginLike =>
  typeof v === "object" && v !== null && "name" in v;

/**
 * Compose direct plugin-hook chains from the runtime plugin objects.
 * Mirrors `pluginsToLifeCycle` (plugin.ts): dev-only plugins are dropped,
 * unscoped hooks stay direct, scoped hooks are wrapped with their compiled
 * matcher (reading `ctx.path` ONLY for scoped plugins), and onResponse runs
 * in reverse registration order (onion way-out).
 */
export const buildFusedChains = (plugins: readonly unknown[]): FusedChains => {
  const preParse: FusedFn[] = [];
  const post: FusedFn[] = [];
  for (const p of plugins) {
    if (!isPluginLike(p) || p.__ignexDevOnly === true) continue;
    const matcher = p.pattern === undefined ? null : createPatternMatcher(p.pattern);
    const { onRequest, onResponse } = p;
    if (typeof onRequest === "function") {
      preParse.push(
        matcher === null
          ? (onRequest as FusedFn)
          : (ctx) => (matcher(ctx.path) ? (onRequest as FusedFn)(ctx) : undefined),
      );
    }
    if (typeof onResponse === "function") {
      post.push(
        matcher === null
          ? (onResponse as FusedFn)
          : (ctx, res) => (matcher(ctx.path) ? (onResponse as FusedFn)(ctx, res) : undefined),
      );
    }
  }
  post.reverse();
  return { preParse, post };
};

/** Interpret one raw plugin-hook result: halt with a Response or continue with a ctx. */
const settle = (raw: unknown, fallback: IgnexContext): FusedResult => {
  if (raw instanceof Response) return { ctx: fallback, response: raw };
  return { ctx: (raw as IgnexContext) ?? fallback };
};

/**
 * Run the pre-handler plugin chain. Sync-fast: the all-sync path returns a
 * plain `FusedResult`; the FIRST promise result seeds the async continuation
 * for itself and every later fn (exactly one call per plugin, mirroring
 * `runHooks`'s thenable branch).
 */
export const runFusedPre = (
  fns: readonly FusedFn[],
  ctx: IgnexContext,
): FusedResult | Promise<FusedResult> => {
  let current = ctx;
  for (let i = 0; i < fns.length; i++) {
    const r = fns[i]!(current);
    if (r instanceof Promise) {
      return (async () => {
        const out = settle(await r, current);
        return out.response !== undefined ? out : runFusedPreFrom(fns, i + 1, out.ctx);
      })();
    }
    if (r instanceof Response) return { ctx: current, response: r };
    if (r) current = r as IgnexContext;
  }
  return { ctx: current };
};

async function runFusedPreFrom(
  fns: readonly FusedFn[],
  start: number,
  ctx: IgnexContext,
): Promise<FusedResult> {
  let current = ctx;
  for (let i = start; i < fns.length; i++) {
    const r = fns[i]!(current);
    if (r instanceof Promise) {
      const out = settle(await r, current);
      if (out.response !== undefined) return out;
      current = out.ctx;
      continue;
    }
    if (r instanceof Response) return { ctx: current, response: r };
    if (r) current = r as IgnexContext;
  }
  return { ctx: current };
}

/**
 * Run the onResponse chain in the deployed (reverse) fn order. Mirrors
 * `runOnResponseChain` (plugin.ts): each fn receives the current response and
 * may replace it; `undefined` passes through; the first thenable seeds the
 * continuation that defers every later fn.
 */
export const runFusedPost = (
  fns: readonly FusedFn[],
  ctx: IgnexContext,
  response: Response,
): FusedResult | Promise<FusedResult> => {
  let current: Response | undefined = response;
  for (let i = 0; i < fns.length; i++) {
    const r = fns[i]!(ctx, current as Response);
    if (r instanceof Promise) {
      return (async () => {
        const raw = (await r) as Response | undefined;
        const next = raw instanceof Response ? raw : current;
        const out = await runFusedPostFrom(fns, i + 1, ctx, next as Response);
        return out;
      })();
    }
    if (r instanceof Response) current = r;
  }
  return { ctx, response: current as Response };
};

async function runFusedPostFrom(
  fns: readonly FusedFn[],
  start: number,
  ctx: IgnexContext,
  response: Response,
): Promise<FusedResult> {
  let current: Response | undefined = response;
  for (let i = start; i < fns.length; i++) {
    const r = fns[i]!(ctx, current as Response);
    if (r instanceof Promise) {
      const raw = (await r) as Response | undefined;
      if (raw instanceof Response) current = raw;
      continue;
    }
    if (r instanceof Response) current = r;
  }
  return { ctx, response: current as Response };
}
