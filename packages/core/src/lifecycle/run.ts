/**
 * @fileoverview Shared lifecycle pipeline — the hook engine and the stage
 * runner.
 *
 * Split out of `./lifecycle` (the `createApp` factory) so the per-request
 * machinery lives in one focused module: `runHooks` interprets hook results
 * (halt with a `Response` / `{ response }`, or continue with a `{ ctx }`),
 * and `runLifecycle` drives the named stage pipeline (pre-handler stages →
 * handler → post-handler stages → afterResponse/trace → error). The compiled
 * server emits `runHooks` calls from `@ignex/core` — this module IS that
 * runtime, imported (not copied) by codegen.
 */

import type { IgnexContext } from "../http/context";
import { applySet } from "../http/headers";
import { errorToResponse } from "../platform/errors";
import type { HookContainer, LifeCycleStore, MaybePromise } from "../types";

/** Outcome of a hook chain: continue with `ctx`, or halt with a `response`. */
export interface RunHooksResult {
  ctx: IgnexContext;
  response?: Response;
}

/** Interpret one hook result: halt with a Response or continue with a ctx. */
const interpretHook = (
  result: unknown,
  ctx: IgnexContext,
): { halted: Response | undefined; next: IgnexContext } => {
  if (result instanceof Response) return { halted: result, next: ctx };
  if (result && typeof result === "object") {
    const res = result as { ok?: boolean; response?: Response; ctx?: IgnexContext };
    if (res.ok === false && res.response instanceof Response)
      return { halted: res.response, next: ctx };
    if (res.response instanceof Response) return { halted: res.response, next: ctx };
    if (res.ctx) return { halted: undefined, next: res.ctx };
  }
  return { halted: undefined, next: ctx };
};

/** Normalize a hook container to its callable fn (or `undefined` when absent/not callable). */
const hookFn = (
  entry: HookContainer | undefined,
): ((ctx: IgnexContext, arg?: unknown) => unknown) | undefined => {
  if (entry == null) return undefined;
  const fn = typeof entry === "function" ? entry : entry.fn;
  return typeof fn === "function" ? fn : undefined;
};

type HookFn = (ctx: IgnexContext, arg?: unknown) => unknown;

/** Memoized flatten of a stage array to its callable hooks (per array identity). */
const flatHookCache = new WeakMap<readonly HookContainer[], readonly HookFn[]>();

/**
 * Pre-resolve a lifecycle stage array's hook containers to their callable
 * functions — ONCE per array. The stage arrays are composed at boot and reused
 * for the life of the app (compiled server module consts, interpreted
 * `buildPreStages`/router bind), so the WeakMap memoization means the hot
 * per-request path iterates PLAIN functions: no per-hook `entry == null` /
 * `typeof` normalization, no per-hook `{ halted, next }` object. Non-callable
 * entries are dropped (matching the previous per-call `hookFn` skip).
 */
const flattenHooks = (hooks: readonly HookContainer[]): readonly HookFn[] => {
  const cached = flatHookCache.get(hooks);
  if (cached) return cached;
  const out: HookFn[] = [];
  for (let i = 0; i < hooks.length; i++) {
    const fn = hookFn(hooks[i]);
    if (fn !== undefined) out.push(fn as HookFn);
  }
  flatHookCache.set(hooks, out);
  return out;
};

/**
 * Run hooks until one halts, WITHOUT forcing an async boundary when every hook
 * is synchronous (the common case: cors/security/ratelimit/logger, native-
 * preflight steady state, sync i18n). Returns the result object synchronously;
 * only when a hook actually returns a Promise is an async continuation used
 * for the remainder. Existing `await` callers keep working; hot-path callers
 * branch on `instanceof Promise` to stay microtask-free (the compiled server
 * emits exactly that).
 *
 * The hook container array is flattened (memoized) on first use, so the hot
 * loop iterates plain functions and interprets results INLINE — zero per-hook
 * intermediate objects on the all-sync path (the common one).
 */
export const runHooks = (
  hooks: readonly HookContainer[] | undefined,
  ctx: IgnexContext,
  arg?: unknown,
): RunHooksResult | Promise<RunHooksResult> => {
  let current = ctx;
  if (!hooks || hooks.length === 0) return { ctx: current };
  const fns = flattenHooks(hooks);
  for (let i = 0; i < fns.length; i++) {
    const r = arg === undefined ? fns[i]!(current) : fns[i]!(current, arg);
    if (r instanceof Promise) {
      // An async hook: interpret it, then continue the remainder asynchronously.
      return (async () => {
        const raw = await r;
        const out = interpretHook(raw, current);
        if (out.halted) return { response: out.halted, ctx: current };
        return runHooksAsync(fns, i + 1, out.next, arg);
      })();
    }
    if (r instanceof Response) return { response: r, ctx: current };
    if (r && typeof r === "object") {
      const res = r as { ok?: boolean; response?: Response; ctx?: IgnexContext };
      if (res.ok === false && res.response instanceof Response)
        return { response: res.response, ctx: current };
      if (res.response instanceof Response) return { response: res.response, ctx: current };
      if (res.ctx) {
        current = res.ctx;
      }
    }
  }
  return { ctx: current };
};

/** Async continuation used once an async hook is encountered. */
async function runHooksAsync(
  fns: readonly HookFn[],
  start: number,
  ctx: IgnexContext,
  arg?: unknown,
): Promise<RunHooksResult> {
  let current = ctx;
  for (let i = start; i < fns.length; i++) {
    const r = arg === undefined ? fns[i]!(current) : fns[i]!(current, arg);
    // Only await actual Promises — a sync hook in the async continuation must
    // not introduce an extra microtask (preserves the original timing/ordering
    // of the interpreted path).
    const raw = r instanceof Promise ? await r : r;
    const out = interpretHook(raw, current);
    if (out.halted) return { response: out.halted, ctx: current };
    current = out.next;
  }
  return { ctx: current };
}

// ============================================================================
// Shared lifecycle pipeline
// ============================================================================

/** Pre-handler lifecycle stages, in execution order. */
export const PRE_HANDLER_STAGES = [
  "start",
  "request",
  "parse",
  "transform",
  "beforeHandle",
] as const;

/** Post-handler lifecycle stages, in execution order. */
export const POST_HANDLER_STAGES = ["afterHandle", "mapResponse"] as const;

/** Compose the pre-handler hook chain once (no per-request allocation). */
export const buildPreStages = (lc: LifeCycleStore): HookContainer[] =>
  PRE_HANDLER_STAGES.flatMap((stage) => lc[stage]);

/** Compose the post-handler hook chain once. */
export const buildPostStages = (lc: LifeCycleStore): HookContainer[] =>
  POST_HANDLER_STAGES.flatMap((stage) => lc[stage]);

/**
 * Run the full request lifecycle pipeline as a sequence of named stages.
 *
 * Shared conceptual model with the compiler-generated server: pre-handler
 * stages (start → request → parse → transform → beforeHandle), the handler,
 * post-handler stages (afterHandle → mapResponse), then afterResponse, with
 * the `error` stage catching failures. Any stage may halt by returning a
 * `Response` (or `{ ok: false, response }`).
 *
 * Written imperatively (rather than composing per-request stage closures) so
 * an empty stage chain costs a single `if` instead of a closure + Promise:
 * empty afterResponse/trace stages are skipped entirely, `runHooks` is only
 * awaited when a chain is non-empty, and no `LifecycleState` objects are
 * spread per request. Semantics are identical to the previous `pipeAsync`
 * composition and are protected by `lifecycle.test.ts`.
 */
export const runLifecycle = async (
  lc: LifeCycleStore,
  pre: readonly HookContainer[],
  post: readonly HookContainer[],
  ctx: IgnexContext,
  handler: (ctx: IgnexContext) => MaybePromise<Response>,
  exposeErrors = false,
): Promise<Response> => {
  // A request that was ALREADY aborted before the pipeline ran is
  // short-circuited: hooks and the handler never run (the client is gone).
  // Matches Elysia's behavior (200 empty). Aborts DURING handling remain
  // observable via `ctx.req.signal` so app code can cancel its own work.
  if (ctx.req.signal.aborted) return new Response(null, { status: 200 });

  // `current` mirrors the ctx seen by the error stage: it is advanced after
  // the pre-handler chain succeeds so a parse/handler failure reports the ctx
  // that got that far (same as the compiled `__handleError`).
  let current = ctx;
  let response: Response | undefined;
  let halted = false;

  const errorStage = async (err: unknown): Promise<Response> => {
    let handled: RunHooksResult;
    try {
      const __r = runHooks(lc.error ?? [], current, err);
      handled = __r instanceof Promise ? await __r : __r;
    } catch {
      // An error-stage hook that throws must not mask the original error —
      // fall back to the default error response (matches compiled __handleError).
      handled = { ctx: current };
    }
    return handled.response ?? errorToResponse(err, exposeErrors);
  };

  // Observe-only stage (afterResponse / trace): run hooks for side effects and
  // never replace the response. A throwing observability hook is surfaced (so
  // broken hooks are debuggable) but can't corrupt an already-finalized
  // response — matches the compiled server.
  const observe = async (
    hooks: readonly HookContainer[] | undefined,
    label: string,
  ): Promise<void> => {
    if ((hooks?.length ?? 0) === 0) return;
    try {
      const __r = runHooks(hooks, current, response as Response);
      if (__r instanceof Promise) await __r;
    } catch (err) {
      console.error(`[ignex] ${label} hook error:`, err);
    }
  };

  try {
    // Pre-handler stages. When the chain is empty there is nothing to run —
    // `current` stays as the incoming ctx and no hook results are synthesized.
    if (pre.length > 0) {
      const __r = runHooks(pre, current);
      const preResult = __r instanceof Promise ? await __r : __r;
      current = preResult.ctx;
      halted = preResult.response !== undefined;
      response = preResult.response;
    }

    // Handler (skipped when a pre stage already halted).
    if (!halted) {
      // When the pre chain is empty, preserve the async boundary the original
      // pre-stage `await runHooks` provided so a request aborted before the
      // handler runs is observable via `ctx.req.signal` (see abort-port.test.ts).
      if (pre.length === 0) await Promise.resolve();
      response = await handler(current);
    }

    // Post-handler stages — may replace the response.
    if (!halted && response !== undefined && post.length > 0) {
      const __r = runHooks(post, current, response);
      const postResult = __r instanceof Promise ? await __r : __r;
      response = postResult.response ?? response;
    }

    // afterResponse then `trace` (observe-only; declared in that order in
    // LifeCycleStore), each receiving the finalized response.
    if (!halted && response !== undefined) {
      await observe(lc.afterResponse, "afterResponse");
      await observe(lc.trace, "trace");
    }

    // A pre-halt returns the response untouched; otherwise apply the
    // accumulated `set` mutations (headers/status/cookie) — matches the
    // compiler-generated `__applySet`, so dev and compiled behave identically.
    return halted ? (response as Response) : applySet(response as Response, current.set);
  } catch (err) {
    return errorStage(err);
  }
};
