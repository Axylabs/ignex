/**
 * Application lifecycle — programmatic app composition with graceful shutdown.
 *
 * `createApp` composes plugins + a lifecycle into a request `handler` that
 * runs the same hook semantics as the compiler-generated server
 * (`__runHooks`: a hook may return a `Response` to halt, `{ response }` to
 * halt, or `{ ctx }` to continue with a new context). `serve` wraps
 * `Bun.serve`; `stop` drains and runs `onStop`/`stop` hooks.
 */
import { pipeAsync } from "@flux/shared";
import { createContext, type FluxContext } from "../http/context";
import { applySet } from "../http/headers";
import { errorToResponse } from "../platform/errors";
import type { HookContainer, LifeCycleStore, MaybePromise } from "../types";
import { mergeLifeCycle } from "./guard";
import { createPluginContext, type FluxPlugin, pluginsToLifeCycle } from "./plugin";

export interface AppOptions {
  /** Lifecycle hooks (merged after plugin hooks). */
  lifecycle?: Partial<LifeCycleStore>;
  plugins?: FluxPlugin[];
  /** The base handler receiving the resolved context. */
  handler(ctx: FluxContext): MaybePromise<Response>;
  onStart?(): MaybePromise<void>;
  onStop?(): MaybePromise<void>;
  /** Expose error details in 500 responses. */
  exposeErrors?: boolean;
}

export interface FluxApp {
  /** Run the full lifecycle pipeline for a request. */
  handler(req: Request): Promise<Response>;
  /**
   * Run plugin `init` hooks (idempotent). Called automatically by `serve()`
   * before the server starts; call it manually if you use `handler()` only.
   */
  init(): Promise<void>;
  /** Start a `Bun.serve` instance backed by this handler. */
  serve(options?: Record<string, unknown> & { port?: number; hostname?: string }): unknown;
  /** Run plugin `close` + `stop` hooks and close the server (draining active requests). */
  stop(options?: { closeActive?: boolean }): Promise<void>;
  readonly lifecycle: LifeCycleStore;
}

/** Mirror of the compiler-generated `__runHooks` hook-execution semantics. */
export const runHooks = async (
  hooks: readonly HookContainer[] | undefined,
  ctx: FluxContext,
  arg?: unknown,
): Promise<{ ctx: FluxContext; response?: Response }> => {
  let current = ctx;
  if (!hooks || hooks.length === 0) return { ctx: current };
  for (const entry of hooks) {
    const fn = typeof entry === "function" ? entry : entry?.fn;
    if (typeof fn !== "function") continue;
    const result = arg === undefined ? await fn(current) : await fn(current, arg);
    if (result instanceof Response) return { response: result, ctx: current };
    if (result && typeof result === "object") {
      const r = result as { ok?: boolean; response?: Response; ctx?: FluxContext };
      if (r.ok === false && r.response instanceof Response)
        return { response: r.response, ctx: current };
      if (r.response instanceof Response) return { response: r.response, ctx: current };
      if (r.ctx) current = r.ctx;
    }
  }
  return { ctx: current };
};

export const createApp = (options: AppOptions): FluxApp => {
  const pluginContext = createPluginContext();
  for (const p of options.plugins ?? []) pluginContext.register(p);

  const pluginLifecycle = pluginsToLifeCycle(options.plugins ?? []);
  const lifecycle = mergeLifeCycle(pluginLifecycle as LifeCycleStore, options.lifecycle ?? {});

  const exposeErrors = options.exposeErrors ?? false;
  // Stage chains are composed once at app creation, not per request.
  const preStages = buildPreStages(lifecycle);
  const postStages = buildPostStages(lifecycle);
  let server: { stop(closeActive?: boolean): void } | null = null;
  let initialized = false;

  const init = async (): Promise<void> => {
    if (initialized) return;
    initialized = true;
    await pluginContext.initAll();
  };

  const handler = (req: Request): Promise<Response> =>
    runLifecycle(
      lifecycle,
      preStages,
      postStages,
      createContext(req, {}),
      options.handler,
      exposeErrors,
    );

  return {
    lifecycle,

    init,

    handler,

    serve(serveOptions = {}) {
      const { port = 3000, hostname = "0.0.0.0", ...rest } = serveOptions;
      const bun = (globalThis as { Bun?: unknown }).Bun;
      if (!bun) {
        throw new Error("createApp().serve() requires Bun; use handler() elsewhere");
      }
      const { serve } = bun as {
        serve: (
          opts: Record<string, unknown> & {
            fetch: (req: Request) => Promise<Response>;
            port: number;
            hostname: string;
          },
        ) => {
          stop(closeActive?: boolean): void;
        };
      };
      // Run plugin init hooks before accepting requests (best-effort).
      void init();
      server = serve({ fetch: handler, port, hostname, ...rest });
      void options.onStart?.();
      return server;
    },

    async stop(stopOptions = {}) {
      const hooks = [...lifecycle.stop, ...(options.onStop ? [options.onStop] : [])];
      for (const hook of hooks) {
        const fn = typeof hook === "function" ? hook : hook.fn;
        if (typeof fn === "function") await fn();
      }
      server?.stop(stopOptions.closeActive ?? false);
      server = null;
      await pluginContext.closeAll();
    },
  };
};

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

/** Pipeline state threaded through the composed `runLifecycle` stages. */
interface LifecycleState {
  ctx: FluxContext;
  /** Set once a stage halts or the handler produces a response. */
  response?: Response | undefined;
  /** True when the pipeline halted before the handler — skips post/afterResponse/applySet. */
  halted: boolean;
}

/**
 * Run the full request lifecycle pipeline as a composition of named stages.
 *
 * Shared conceptual model with the compiler-generated server: pre-handler
 * stages (start → request → parse → transform → beforeHandle), the handler,
 * post-handler stages (afterHandle → mapResponse), then afterResponse, with
 * the `error` stage catching failures. Any stage may halt by returning a
 * `Response` (or `{ ok: false, response }`).
 *
 * The stages are pure functions over a `LifecycleState` carrier, composed
 * left-to-right with `pipeAsync` from `@flux/shared`; each stage short-
 * circuits when a previous stage already halted. The pipeline is composed
 * once per request (matching the previous imperative form) and is protected
 * by `lifecycle.test.ts`.
 */
export const runLifecycle = async (
  lc: LifeCycleStore,
  pre: readonly HookContainer[],
  post: readonly HookContainer[],
  ctx: FluxContext,
  handler: (ctx: FluxContext) => MaybePromise<Response>,
  exposeErrors = false,
): Promise<Response> => {
  // `current` mirrors the ctx seen by the error stage: it is advanced after
  // the pre-handler chain succeeds so a parse/handler failure reports the ctx
  // that got that far (same as the compiled `__handleError`).
  let current = ctx;

  const preStages = async (s: LifecycleState): Promise<LifecycleState> => {
    const preResult = await runHooks(pre, s.ctx);
    current = preResult.ctx;
    const halted = preResult.response !== undefined;
    return { ctx: current, response: preResult.response, halted };
  };

  const handle = async (s: LifecycleState): Promise<LifecycleState> => {
    if (s.halted) return s;
    return { ...s, response: await handler(s.ctx) };
  };

  const postStages = async (s: LifecycleState): Promise<LifecycleState> => {
    if (s.halted || s.response === undefined) return s;
    const postResult = await runHooks(post, s.ctx, s.response);
    return { ...s, response: postResult.response ?? s.response };
  };

  const afterResponse = async (s: LifecycleState): Promise<LifecycleState> => {
    if (s.halted || s.response === undefined) return s;
    // observe-only: a throwing observability hook must not corrupt an
    // already-finalized response (e.g. turn a 200 into a 500).
    try {
      await runHooks(lc.afterResponse ?? [], s.ctx, s.response);
    } catch {
      // swallow
    }
    return s;
  };

  const applySetStage = async (s: LifecycleState): Promise<Response> =>
    // A pre-halt returns the response untouched; otherwise apply the
    // accumulated `set` mutations (headers/status/cookie) — matches the
    // compiler-generated `__applySet`, so dev and compiled behave identically.
    s.halted ? (s.response as Response) : applySet(s.response as Response, s.ctx.set);

  const errorStage = async (err: unknown): Promise<Response> => {
    let handled: Awaited<ReturnType<typeof runHooks>>;
    try {
      handled = await runHooks(lc.error ?? [], current, err);
    } catch {
      // An error-stage hook that throws must not mask the original error —
      // fall back to the default error response (matches compiled __handleError).
      handled = { ctx: current };
    }
    return handled.response ?? errorToResponse(err, exposeErrors);
  };

  try {
    return (await pipeAsync({ ctx, halted: false } as LifecycleState)(
      preStages,
      handle,
      postStages,
      afterResponse,
      applySetStage,
    )) as Response;
  } catch (err) {
    return errorStage(err);
  }
};
