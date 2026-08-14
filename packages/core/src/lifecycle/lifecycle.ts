/**
 * Application lifecycle — programmatic app composition with graceful shutdown.
 *
 * `createApp` composes plugins + a lifecycle into a request `handler` that
 * runs the same hook semantics as the compiler-generated server
 * (`__runHooks`: a hook may return a `Response` to halt, `{ response }` to
 * halt, or `{ ctx }` to continue with a new context). `serve` wraps
 * `Bun.serve`; `stop` drains and runs `onStop`/`stop` hooks.
 */
import { initNative } from "@ignex/native";
import { HttpResponseCache } from "../data/cache";
import {
  type ContextOptions,
  createContext,
  type IgnexContext,
  type IgnexServer,
} from "../http/context";
import { applySet } from "../http/headers";
import type { IgnexRouter } from "../http/router";
import { errorToResponse } from "../platform/errors";
import type { HookContainer, LifeCycleStore, MaybePromise } from "../types";
import { mergeLifeCycle } from "./hooks";
import {
  createPluginContext,
  type IgnexPlugin,
  pluginContextToLifecycle,
  pluginsToLifeCycle,
} from "./plugin";

/**
 * Options for {@link createApp}.
 */
export interface AppOptions {
  /** Lifecycle hooks (merged after plugin hooks). */
  lifecycle?: Partial<LifeCycleStore>;
  plugins?: IgnexPlugin[];
  /**
   * The base handler receiving the resolved context. Required UNLESS a
   * `router` is provided (routed apps dispatch per-route handlers instead).
   */
  handler?(ctx: IgnexContext): MaybePromise<Response>;
  /**
   * Optional interpreted router (see `createRouter`). When present, `serve()`
   * builds a Bun-native `routes` table from it (Rust path/method matching —
   * no JS per-request scan) and `handler()` dispatches through it. Without a
   * router, every request reaches the single `handler`.
   */
  router?: IgnexRouter;
  onStart?(): MaybePromise<void>;
  onStop?(): MaybePromise<void>;
  /** Expose error details in 500 responses. */
  exposeErrors?: boolean;
  /**
   * App-scoped response cache for `ctx.cache()`. Defaults to a fresh cache
   * scoped to this app; pass one here to share a specific cache.
   */
  cache?: HttpResponseCache;
  /** Trust `x-real-ip` / `x-forwarded-for` when `server.requestIP` is unavailable. */
  trustProxy?: boolean;
}

/**
 * The runtime app built by {@link createApp}.
 */
export interface IgnexApp {
  /**
   * Run the full lifecycle pipeline for a request. When `server` is provided
   * (as `serve()` does), it is wired onto `ctx.server` so `ctx.ip` resolves
   * the real socket address — matching the compiled server.
   */
  handler(req: Request, server?: IgnexServer): Promise<Response>;
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
  ctx: IgnexContext,
  arg?: unknown,
): Promise<{ ctx: IgnexContext; response?: Response }> => {
  let current = ctx;
  if (!hooks || hooks.length === 0) return { ctx: current };
  for (const entry of hooks) {
    const fn = typeof entry === "function" ? entry : entry?.fn;
    if (typeof fn !== "function") continue;
    const result = arg === undefined ? await fn(current) : await fn(current, arg);
    if (result instanceof Response) return { response: result, ctx: current };
    if (result && typeof result === "object") {
      const r = result as { ok?: boolean; response?: Response; ctx?: IgnexContext };
      if (r.ok === false && r.response instanceof Response)
        return { response: r.response, ctx: current };
      if (r.response instanceof Response) return { response: r.response, ctx: current };
      if (r.ctx) current = r.ctx;
    }
  }
  return { ctx: current };
};

/**
 * Build a runtime app from lifecycle hooks/plugins and a base handler.
 *
 * The interpreted counterpart of the compiler-generated server: stage chains
 * are composed once at creation, and each request runs them via
 * {@link runLifecycle}. `serve()` bootstraps `Bun.serve`.
 *
 * @param options - Hooks, plugins, handler, and runtime tuning.
 * @returns The app (see {@link IgnexApp}).
 */
export const createApp = (options: AppOptions): IgnexApp => {
  const pluginContext = createPluginContext();
  for (const p of options.plugins ?? []) pluginContext.register(p);

  // Mirror the compiler-generated server: `addHook`-registered hooks (from
  // legacy callable/`setup` plugins) are converted first, then plugin methods
  // (onRequest/onResponse/onError), then user lifecycle — so `addHook`-based
  // plugins actually run under the interpreted runtime too.
  const pluginLifecycle = mergeLifeCycle(
    pluginContextToLifecycle(pluginContext) as LifeCycleStore,
    pluginsToLifeCycle(options.plugins ?? []) as LifeCycleStore,
  );
  const lifecycle = mergeLifeCycle(pluginLifecycle as LifeCycleStore, options.lifecycle ?? {});

  const exposeErrors = options.exposeErrors ?? false;
  // Stage chains are composed once at app creation, not per request.
  const preStages = buildPreStages(lifecycle);
  const postStages = buildPostStages(lifecycle);
  let server: { stop(closeActive?: boolean): void } | null = null;
  let initialized = false;

  // Per-app response cache: entries are scoped to THIS app unless the caller
  // passes an explicit cache. This prevents URL-keyed collisions between apps
  // sharing a process (previously they fell back to a single module-level
  // cache in http/context.ts).
  const appCache = options.cache ?? new HttpResponseCache();

  // exactOptionalPropertyTypes: only set optional fields that are defined.
  // The context options are app-invariant (cache + trustProxy are fixed at
  // createApp time), so they are computed ONCE instead of per request.
  const ctxOptions: ContextOptions = {};
  ctxOptions.cache = appCache;
  if (options.trustProxy !== undefined) ctxOptions.trustProxy = options.trustProxy;

  const init = async (): Promise<void> => {
    if (initialized) return;
    initialized = true;
    // Eagerly pre-warm the Rust addon (rayon pool + dlopen) at boot instead
    // of lazily on the first request. Load-time cost is acceptable; runtime
    // latency is not. No-op without the addon.
    initNative();
    await pluginContext.initAll();
  };

  // When a router is present, bind the composed lifecycle (plugins + user
  // hooks) and context options into it once, mirroring the compiled server's
  // stage arrays (start/request/parse/transform before validation; the rest
  // after). The router's per-route wrapper then guards each stage with a
  // length check instead of composing per-request closures.
  const router = options.router;
  if (!options.handler && !router) {
    throw new Error("createApp requires a `handler` unless a `router` is provided.");
  }
  // `baseHandler` is guaranteed defined in the non-router branch (guard above);
  // the nullish fallback only exists to satisfy the type without a non-null
  // assertion and is never invoked in practice.
  const baseHandler =
    options.handler ??
    (() => {
      throw new Error("createApp requires a `handler` unless a `router` is provided.");
    });
  if (router) {
    router.bind({
      preParseStages: [
        ...(lifecycle.start ?? []),
        ...(lifecycle.request ?? []),
        ...(lifecycle.parse ?? []),
        ...(lifecycle.transform ?? []),
      ],
      beforeHandle: lifecycle.beforeHandle ?? [],
      afterHandle: lifecycle.afterHandle ?? [],
      mapResponse: lifecycle.mapResponse ?? [],
      afterResponse: lifecycle.afterResponse ?? [],
      error: lifecycle.error ?? [],
      exposeErrors,
      ctx: ctxOptions,
    });
  }

  const handler = (req: Request, serverArg?: IgnexServer): Promise<Response> => {
    // Routed apps dispatch through the router (JS matching) so direct
    // `handler()` calls behave like the compiled server; `serve()` uses Bun's
    // native `routes` instead.
    if (router) return router.dispatch(req, serverArg);

    const ctx = createContext(req, {}, ctxOptions);
    // Wire the Bun server so `ctx.ip` resolves the real socket address —
    // matching the compiled server (which emits `ctx.server = server`).
    // Without this, interpreted `ctx.ip` always fell back to "anonymous"
    // (skipping the ~375ns `server.requestIP` socket lookup entirely).
    if (serverArg) ctx.server = serverArg;
    return runLifecycle(lifecycle, preStages, postStages, ctx, baseHandler, exposeErrors);
  };

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
            fetch: (req: Request, server?: unknown) => Promise<Response>;
            port: number;
            hostname: string;
          },
        ) => {
          stop(closeActive?: boolean): void;
        };
      };
      // Run plugin init hooks before accepting requests (best-effort). A
      // rejected init must not become an unhandled rejection / crash the app.
      void init().catch((err) => {
        console.error("[ignex] plugin init failed:", err);
      });
      server = serve(
        router
          ? {
              // Routed apps use Bun's native route table (Rust path/method
              // matching) with the router's fallback for 404/405/OPTIONS —
              // the same shape as the AOT-compiled server.
              routes: router.buildRoutes(),
              fetch: (req, srv) => router.fetch(req, srv as IgnexServer | undefined),
              port,
              hostname,
              ...rest,
            }
          : {
              fetch: (req, srv) => handler(req, srv as IgnexServer | undefined),
              port,
              hostname,
              ...rest,
            },
      );
      void Promise.resolve(options.onStart?.()).catch((err) => {
        console.error("[ignex] onStart failed:", err);
      });
      return server;
    },

    async stop(stopOptions = {}) {
      const hooks = [...lifecycle.stop, ...(options.onStop ? [options.onStop] : [])];
      // Run every stop hook even if one throws, so closeAll() always runs and
      // resources (stores, intervals, connections) are not leaked.
      const results = await Promise.allSettled(
        hooks.map(async (hook) => {
          const fn = typeof hook === "function" ? hook : hook.fn;
          if (typeof fn === "function") await fn();
        }),
      );
      for (const r of results) {
        if (r.status === "rejected") console.error("[ignex] stop hook failed:", r.reason);
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
  // `current` mirrors the ctx seen by the error stage: it is advanced after
  // the pre-handler chain succeeds so a parse/handler failure reports the ctx
  // that got that far (same as the compiled `__handleError`).
  let current = ctx;
  let response: Response | undefined;
  let halted = false;

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
    // Pre-handler stages. When the chain is empty there is nothing to run —
    // `current` stays as the incoming ctx and no hook results are synthesized.
    if (pre.length > 0) {
      const preResult = await runHooks(pre, current);
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
      const postResult = await runHooks(post, current, response);
      response = postResult.response ?? response;
    }

    // afterResponse (observe-only): a throwing observability hook must not
    // corrupt an already-finalized response (e.g. turn a 200 into a 500), but
    // the error is surfaced so broken hooks are debuggable (matches compiled).
    if (!halted && response !== undefined && (lc.afterResponse?.length ?? 0) > 0) {
      try {
        await runHooks(lc.afterResponse, current, response);
      } catch (err) {
        console.error("[ignex] afterResponse hook error:", err);
      }
    }

    // `trace` is the final observe-only stage (declared after `afterResponse`
    // in LifeCycleStore); it receives the finalized response and can never
    // replace or corrupt it. A throwing trace hook is a bug — surface it.
    if (!halted && response !== undefined && (lc.trace?.length ?? 0) > 0) {
      try {
        await runHooks(lc.trace, current, response);
      } catch (err) {
        console.error("[ignex] trace hook error:", err);
      }
    }

    // A pre-halt returns the response untouched; otherwise apply the
    // accumulated `set` mutations (headers/status/cookie) — matches the
    // compiler-generated `__applySet`, so dev and compiled behave identically.
    return halted ? (response as Response) : applySet(response as Response, current.set);
  } catch (err) {
    return errorStage(err);
  }
};
