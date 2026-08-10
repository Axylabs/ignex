/**
 * Application lifecycle — programmatic app composition with graceful shutdown.
 *
 * `createApp` composes plugins + a lifecycle into a request `handler` that
 * runs the same hook semantics as the compiler-generated server
 * (`__runHooks`: a hook may return a `Response` to halt, `{ response }` to
 * halt, or `{ ctx }` to continue with a new context). `serve` wraps
 * `Bun.serve`; `stop` drains and runs `onStop`/`stop` hooks.
 */
import { applySet, createContext, type FluxContext } from "./context";
import { errorToResponse } from "./errors";
import { mergeLifeCycle } from "./guard";
import { createPluginContext, type FluxPlugin, pluginsToLifeCycle } from "./plugin";
import type { HookContainer, LifeCycleStore, MaybePromise } from "./types";

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

/**
 * Run the full request lifecycle pipeline.
 *
 * Shared conceptual model with the compiler-generated server: pre-handler
 * stages (start → request → parse → transform → beforeHandle), the handler,
 * post-handler stages (afterHandle → mapResponse), then afterResponse, with
 * the `error` stage catching failures. Any stage may halt by returning a
 * `Response` (or `{ ok: false, response }`).
 */
export const runLifecycle = async (
  lc: LifeCycleStore,
  pre: readonly HookContainer[],
  post: readonly HookContainer[],
  ctx: FluxContext,
  handler: (ctx: FluxContext) => MaybePromise<Response>,
  exposeErrors = false,
): Promise<Response> => {
  let current = ctx;

  try {
    const preResult = await runHooks(pre, current);
    if (preResult.response) return preResult.response;
    current = preResult.ctx;

    const response = await handler(current);

    const postResult = await runHooks(post, current, response);
    const final = postResult.response ?? response;

    // afterResponse observes the final response but cannot replace it. A
    // throwing observability hook must not corrupt an already-finalized
    // response (e.g. turn a 200 into a 500), so its errors are isolated.
    try {
      await runHooks(lc.afterResponse ?? [], current, final);
    } catch {
      // observe-only: swallow
    }

    // Apply accumulated `set` mutations (headers/status/cookie) — matches the
    // compiler-generated `__applySet`, so dev and compiled behave identically.
    return applySet(final, current.set);
  } catch (err) {
    let handled: Awaited<ReturnType<typeof runHooks>>;
    try {
      handled = await runHooks(lc.error ?? [], current, err);
    } catch {
      // An error-stage hook that throws must not mask the original error —
      // fall back to the default error response (matches compiled __handleError).
      handled = { ctx: current };
    }
    return handled.response ?? errorToResponse(err, exposeErrors);
  }
};
