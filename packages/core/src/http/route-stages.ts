/**
 * @fileoverview Route lifecycle stage runners — the guarded pre/post/observe
 * stage helpers shared by the interpreted router.
 *
 * Extracted from `./router` so the per-route pipeline is a set of small,
 * independently testable functions: each runner is pure over
 * `(hooks, ctx, response)` and returns the interpreted result the same way
 * the compiled server's `__runHooks` path does (halt on `Response`, advance
 * on `{ ctx }`). The router composes them; the stage arrays come from
 * `createApp`'s bound lifecycle.
 */

import { parseQueryFromURL } from "../data/query";
import { validateAsync } from "../data/schema";
import { runHooks, runTimed } from "../lifecycle/lifecycle";
import type { AnySchema, HookContainer } from "../types";
import type { IgnexContext } from "./context";
import { parseCookieString } from "./cookies";
import { applySet, headersToRecord } from "./headers";
import type { RouteSchemas } from "./route";

/** Runtime per-part validation (mirrors the compiled full-context prelude). */
export const validateSchema = async (
  schema: RouteSchemas,
  ctx: IgnexContext,
  req: Request,
): Promise<void> => {
  if (schema.params) await validateAsync(schema.params as AnySchema, ctx.params, "params");
  if (schema.query) {
    const query = parseQueryFromURL(req.url);
    // Plain assignment through the ctx.query SETTER (~8x the old
    // Object.defineProperty on this hot path).
    ctx.query = query as unknown as URLSearchParams;
    await validateAsync(schema.query as AnySchema, query, "query");
  }
  if (schema.headers) {
    await validateAsync(schema.headers as AnySchema, headersToRecord(req.headers), "headers");
  }
  if (schema.cookie) {
    await validateAsync(
      schema.cookie as AnySchema,
      parseCookieString(req.headers.get("cookie")),
      "cookie",
    );
  }
  if (schema.body) {
    await validateAsync(schema.body as AnySchema, await ctx.body.json(), "body");
  }
};

/**
 * Run pre-handler hooks: halt with the applied response, or advance the ctx.
 * Shared by the route pipeline and the 404/405/OPTIONS fallback. When a trace
 * is active, the stage is recorded as a `lifecycle` span named `label`.
 */
export const runPreStage = async (
  hooks: readonly HookContainer[],
  ctx: IgnexContext,
  label = "hooks",
): Promise<{ halt: Response | undefined; ctx: IgnexContext }> => {
  if (hooks.length === 0) return { halt: undefined, ctx };
  const __r = runTimed(label, "lifecycle", () => runHooks(hooks, ctx));
  const r = __r instanceof Promise ? await __r : __r;
  if (r.response) return { halt: applySet(r.response, r.ctx.set), ctx: r.ctx };
  return { halt: undefined, ctx: r.ctx };
};

/**
 * Run post-handler hooks, threading ctx + response through (either may be
 * replaced). Shared by the route pipeline and the fallback path.
 */
export const runPostStage = async (
  hooks: readonly HookContainer[],
  ctx: IgnexContext,
  response: Response,
  label = "hooks",
): Promise<{ ctx: IgnexContext; response: Response }> => {
  if (hooks.length === 0) return { ctx, response };
  const __r = runTimed(label, "lifecycle", () => runHooks(hooks, ctx, response));
  const r = __r instanceof Promise ? await __r : __r;
  return { ctx: r.ctx ?? ctx, response: r.response ?? response };
};

/** Run observe-only hooks (afterResponse): never replaces the response. */
export const runObserveStage = async (
  hooks: readonly HookContainer[],
  ctx: IgnexContext,
  response: Response,
  label = "afterResponse",
): Promise<void> => {
  if (hooks.length === 0) return;
  try {
    const __r = runTimed(label, "lifecycle", () => runHooks(hooks, ctx, response));
    if (__r instanceof Promise) await __r;
  } catch (err) {
    console.error(`[ignex] ${label} hook error:`, err);
  }
};
