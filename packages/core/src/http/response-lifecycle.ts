/**
 * @fileoverview Shared non-success response pipeline for the interpreted
 * router. Error and guard-halt responses receive the same post-processing as
 * successful responses without re-running a stage that already threw.
 */

import { runHooks, runTimed } from "../lifecycle/lifecycle";
import { errorToResponse } from "../platform/errors";
import type { HookContainer } from "../types";
import type { IgnexContext } from "./context";
import { applySet } from "./headers";
import { runObserveStage, runPostStage } from "./route-stages";

/** Response stages required by the non-success pipeline. */
export interface ResponseLifecycleStages {
  readonly afterHandle: readonly HookContainer[];
  readonly mapResponse: readonly HookContainer[];
  readonly afterResponse: readonly HookContainer[];
  readonly error: readonly HookContainer[];
}

/** Complete an error/halt response without masking it with a broken hook. */
export const finishResponse = async (
  initialResponse: Response,
  initialCtx: IgnexContext,
  stages: ResponseLifecycleStages,
  postRan = false,
): Promise<Response> => {
  let ctx = initialCtx;
  let response = initialResponse;

  if (!postRan) {
    for (const [label, hooks] of [
      ["afterHandle", stages.afterHandle],
      ["mapResponse", stages.mapResponse],
    ] as const) {
      try {
        ({ ctx, response } = await runPostStage(hooks, ctx, response, label));
      } catch (error) {
        console.error(`[ignex] ${label} hook threw on a non-success response:`, error);
      }
    }
  }

  await runObserveStage(stages.afterResponse, ctx, response);
  return applySet(response, ctx.set);
};

/** Run error hooks, map the original failure, then decorate the response. */
export const handleRouteError = async (
  error: unknown,
  initialCtx: IgnexContext,
  stages: ResponseLifecycleStages,
  exposeErrors: boolean,
  postRan = false,
): Promise<Response> => {
  let ctx = initialCtx;
  let response: Response | undefined;
  try {
    const pending = runTimed("error", "lifecycle", () => runHooks(stages.error, ctx, error));
    const result = pending instanceof Promise ? await pending : pending;
    response = result.response;
    ctx = result.ctx ?? ctx;
  } catch (hookError) {
    console.error("[ignex] error-stage hook threw:", hookError);
  }

  return finishResponse(
    response ?? errorToResponse(error, exposeErrors, ctx),
    ctx,
    stages,
    postRan,
  );
};
