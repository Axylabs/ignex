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

import { debugStageEnd } from "../debug/tracer";
import { abortedResponse } from "../http/abort";
import type { IgnexContext } from "../http/context";
import { applySet } from "../http/headers";
import { errorToResponse } from "../platform/errors";
import type { HookContainer, LifeCycleStore, MaybePromise } from "../types";
import { lifecycleTracing, type RunHooksResult, runHooks, runTimed } from "./hook-engine";

export { lifecycleTracing, runHooks, runTimed } from "./hook-engine";
// Backward-compatible surface (the compiled server / `lifecycle.ts` import
// these names from this module).
export { debugStageEnd };

/** Pre-parse lifecycle stages, in execution order (start → request → parse → transform). */
export const PRE_PARSE_STAGES = ["start", "request", "parse", "transform"] as const;

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
/** Result of running the traced pre-handler stages. */
interface TracedPreResult {
  ctx: IgnexContext;
  response?: Response;
  halted: boolean;
}

/**
 * Run each pre-handler stage separately so the debugbar waterfall shows where
 * the request spent its time. The `request` stage is special — it is what
 * CREATES the trace (the debugbar plugin's onRequest runs inside it) — so its
 * row is recorded the moment the stage returns instead of being wrapped
 * beforehand.
 */
const runPreStagesTraced = async (
  lc: LifeCycleStore,
  ctx: IgnexContext,
): Promise<TracedPreResult> => {
  let current = ctx;
  for (const stage of PRE_PARSE_STAGES) {
    const hooks = lc[stage];
    if (hooks === undefined || hooks.length === 0) continue;
    const __r = runTimed(stage, "lifecycle", () => runHooks(hooks, current));
    const out = __r instanceof Promise ? await __r : __r;
    if (stage === "request") debugStageEnd("request");
    current = out.ctx;
    if (out.response !== undefined) return { ctx: current, response: out.response, halted: true };
  }
  const hooks = lc.beforeHandle;
  if (hooks !== undefined && hooks.length > 0) {
    const __r = runTimed("beforeHandle", "lifecycle", () => runHooks(hooks, current));
    const before = __r instanceof Promise ? await __r : __r;
    current = before.ctx;
    if (before.response !== undefined) {
      return { ctx: current, response: before.response, halted: true };
    }
  }
  return { ctx: current, halted: false };
};

/** Run each post-handler stage separately so the waterfall shows them. */
const runPostStagesTraced = async (
  lc: LifeCycleStore,
  ctx: IgnexContext,
  response: Response,
): Promise<{ ctx: IgnexContext; response: Response }> => {
  let current = ctx;
  let res = response;
  for (const stage of POST_HANDLER_STAGES) {
    const hooks = lc[stage];
    if (hooks === undefined || hooks.length === 0) continue;
    const __r = runTimed(stage, "lifecycle", () => runHooks(hooks, current, res));
    const out = __r instanceof Promise ? await __r : __r;
    current = out.ctx;
    res = out.response ?? res;
  }
  return { ctx: current, response: res };
};

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
  // Shared with the AOT core fn (`http/abort.ts`) so the two paths agree.
  if (ctx.req.signal.aborted) return abortedResponse();

  // `current` mirrors the ctx seen by the error stage: it is advanced after
  // the pre-handler chain succeeds so a parse/handler failure reports the ctx
  // that got that far (same as the compiled `__handleError`).
  let current = ctx;
  let response: Response | undefined;
  let halted = false;
  /** True once the response pipeline has started (so an error thrown BY it
   *  is not fed through it a second time). */
  let postRan = false;

  const errorStage = async (err: unknown): Promise<Response> => {
    let handled: RunHooksResult;
    try {
      const __r = runTimed("error", "lifecycle", () => runHooks(lc.error ?? [], current, err));
      handled = __r instanceof Promise ? await __r : __r;
    } catch {
      // An error-stage hook that throws must not mask the original error —
      // fall back to the default error response (matches compiled __handleError).
      handled = { ctx: current };
    }
    return handled.response ?? errorToResponse(err, exposeErrors, current);
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
      const __r = runTimed(label, "lifecycle", () =>
        runHooks(hooks, current, response as Response),
      );
      if (__r instanceof Promise) await __r;
    } catch (err) {
      console.error(`[ignex] ${label} hook error:`, err);
    }
  };

  // Error replies run the response pipeline too: plugins decorate EVERY
  // response they see (CORS echo, compression, security headers), and `set`
  // mutations made by pre-handler hooks are still delivered. A throwing
  // response hook must not replace the error with a 500.
  const finishError = async (err: unknown): Promise<Response> => {
    response = await errorStage(err);
    if (!postRan && post.length > 0) {
      try {
        if (lifecycleTracing()) {
          const traced = await runPostStagesTraced(lc, current, response);
          current = traced.ctx;
          response = traced.response;
        } else {
          const __r = runHooks(post, current, response);
          const postResult = __r instanceof Promise ? await __r : __r;
          current = postResult.ctx ?? current;
          response = postResult.response ?? response;
        }
      } catch (postErr) {
        console.error("[ignex] response hook threw on an error response:", postErr);
      }
    }
    await observe(lc.afterResponse, "afterResponse");
    await observe(lc.trace, "trace");
    return applySet(response as Response, current.set);
  };

  try {
    // Pre-handler stages. When the chain is empty there is nothing to run —
    // `current` stays as the incoming ctx and no hook results are synthesized.
    if (pre.length > 0) {
      if (lifecycleTracing()) {
        // Instrumented path: per-stage spans so the waterfall shows the
        // request / beforeHandle rows (see `runPreStagesTraced`).
        const traced = await runPreStagesTraced(lc, current);
        current = traced.ctx;
        halted = traced.halted;
        response = traced.response;
      } else {
        const __r = runHooks(pre, current);
        const preResult = __r instanceof Promise ? await __r : __r;
        current = preResult.ctx;
        halted = preResult.response !== undefined;
        response = preResult.response;
      }
    }

    // Handler (skipped when a pre stage already halted).
    if (!halted) {
      // When the pre chain is empty, preserve the async boundary the original
      // pre-stage `await runHooks` provided so a request aborted before the
      // handler runs is observable via `ctx.req.signal` (see abort-port.test.ts).
      if (pre.length === 0) await Promise.resolve();
      // `await` (not an instanceof branch) so a synchronous handler still
      // crosses the same microtask boundary as before (the union from
      // `runTimed` is awaitable either way).
      response = await runTimed("handler", "lifecycle", () => handler(current));
    }

    // Post-handler stages — may replace the response. These run for HALTS too
    // (a guard's 401/403): plugins decorate every response they see, so CORS
    // echo/compression/security headers must not vanish on rejected requests.
    if (response !== undefined && post.length > 0) {
      postRan = true;
      if (lifecycleTracing()) {
        const traced = await runPostStagesTraced(lc, current, response);
        current = traced.ctx;
        response = traced.response;
      } else {
        const __r = runHooks(post, current, response);
        const postResult = __r instanceof Promise ? await __r : __r;
        current = postResult.ctx ?? current;
        response = postResult.response ?? response;
      }
    }

    // afterResponse then `trace` (observe-only; declared in that order in
    // LifeCycleStore), each receiving the finalized response.
    if (response !== undefined) {
      await observe(lc.afterResponse, "afterResponse");
      await observe(lc.trace, "trace");
    }

    // Apply the accumulated `set` mutations (headers/status/cookie) on EVERY
    // finalized response — INCLUDING halts. A guard that writes a cookie (or
    // header) and then halts must still deliver it: the compiler-generated
    // pipeline applies `__applySet` on every halt return, so dev and compiled
    // behave identically. Skipping applySet here silently dropped e.g. the
    // CSRF bootstrap cookie written right before a 403.
    return applySet(response as Response, current.set);
  } catch (err) {
    return finishError(err);
  }
};
