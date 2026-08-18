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
import { resolveServeTls, type ServerProtocolConfig, type ServerTlsConfig } from "../http/tls";
import { errorToResponse } from "../platform/errors";
import { installProcessGuards } from "../platform/process-guards";
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
   * Fail CLOSED on plugin `init` errors. Default (best-effort) logs a rejected
   * `init` and keeps serving. With `strictInit: true`, a failed init stops the
   * listener so the app never serves in a half-initialized state (e.g. a DB
   * connection that failed at boot) — the process should be restarted after
   * the underlying issue is fixed.
   */
  strictInit?: boolean;
  /**
   * App-scoped response cache for `ctx.cache()`. Defaults to a fresh cache
   * scoped to this app; pass one here to share a specific cache.
   */
  cache?: HttpResponseCache;
  /** Trust `x-real-ip` / `x-forwarded-for` when `server.requestIP` is unavailable. */
  trustProxy?: boolean;
}

/**
 * Options for {@link IgnexApp.serve}.
 *
 * `port`, `hostname`, `https`, `tls` and `certDir` are typed and handled by
 * ignex (including the HTTPS-by-default TLS resolution); every other key is
 * passed through to `Bun.serve` untyped (`websocket`, `maxRequestBodySize`,
 * `reusePort`, `headers`, `idleTimeout`, …).
 */
export type ServeOptions = Record<string, unknown> & {
  port?: number;
  hostname?: string;
  /** Serve HTTPS over TLS. Default `true`; set `false` for plain HTTP/1. */
  https?: boolean;
  /** TLS cert/key file paths. Omit in dev to auto-generate local certs. */
  tls?: ServerTlsConfig;
  /** Directory for generated dev certs (default `.ignex/certs`). */
  certDir?: string;
};

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
  serve(options?: ServeOptions): unknown;
  /** Run plugin `close` + `stop` hooks and close the server (draining active requests). */
  stop(options?: { closeActive?: boolean }): Promise<void>;
  readonly lifecycle: LifeCycleStore;
}

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

/**
 * Run hooks until one halts, WITHOUT forcing an async boundary when every hook
 * is synchronous (the common case: cors/security/ratelimit/logger, native-
 * preflight steady state, sync i18n). Returns the result object synchronously;
 * only when a hook actually returns a Promise is an async continuation used
 * for the remainder. Existing `await` callers keep working; hot-path callers
 * branch on `instanceof Promise` to stay microtask-free (the compiled server
 * emits exactly that).
 */
export const runHooks = (
  hooks: readonly HookContainer[] | undefined,
  ctx: IgnexContext,
  arg?: unknown,
): RunHooksResult | Promise<RunHooksResult> => {
  let current = ctx;
  if (!hooks || hooks.length === 0) return { ctx: current };
  for (let i = 0; i < hooks.length; i++) {
    const entry = hooks[i];
    if (entry == null) continue;
    const fn = typeof entry === "function" ? entry : entry.fn;
    if (typeof fn !== "function") continue;
    const r = arg === undefined ? fn(current) : fn(current, arg);
    if (r instanceof Promise) {
      // An async hook: continue the remainder asynchronously from here.
      return (async () => {
        const first = interpretHook(await r, current);
        if (first.halted) return { response: first.halted, ctx: current };
        return runHooksAsync(hooks, i + 1, first.next, arg);
      })();
    }
    const out = interpretHook(r, current);
    if (out.halted) return { response: out.halted, ctx: current };
    current = out.next;
  }
  return { ctx: current };
};

/** Async continuation used once an async hook is encountered. */
async function runHooksAsync(
  hooks: readonly HookContainer[],
  start: number,
  ctx: IgnexContext,
  arg?: unknown,
): Promise<RunHooksResult> {
  let current = ctx;
  for (let i = start; i < hooks.length; i++) {
    const entry = hooks[i];
    if (entry == null) continue;
    const fn = typeof entry === "function" ? entry : entry.fn;
    if (typeof fn !== "function") continue;
    const r = arg === undefined ? fn(current) : fn(current, arg);
    const result = r instanceof Promise ? await r : r;
    const out = interpretHook(result, current);
    if (out.halted) return { response: out.halted, ctx: current };
    current = out.next;
  }
  return { ctx: current };
}

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
    // Plugin route registration (e.g. `openapi()`'s spec/docs endpoints) must
    // happen before the lifecycle is bound into the router so the routes are
    // present in `buildRoutes`/`dispatch`. Only interpreted apps (which own a
    // router) get this; compiled apps contribute lifecycle hooks only.
    for (const p of options.plugins ?? []) p.routes?.(router);
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

    serve(serveOptions: ServeOptions = {}) {
      // Production entry: never let a stray unhandled rejection (user hook,
      // fire-and-forget promise) terminate the process; exit cleanly on an
      // uncaught exception so the supervisor can restart. See process-guards.
      installProcessGuards();
      const { port = 3000, hostname = "0.0.0.0", https, tls, certDir, ...rest } = serveOptions;
      // HTTPS by default: `Bun.serve` needs a `tls` block for TLS, so resolve
      // one up front (user certs, dev auto-generated certs, or a warned
      // HTTP/1 fallback in production).
      const protocolCfg: ServerProtocolConfig = {};
      if (https !== undefined) protocolCfg.https = https;
      if (tls !== undefined) protocolCfg.tls = tls;
      if (certDir !== undefined) protocolCfg.certDir = certDir;
      const resolvedTls = resolveServeTls(protocolCfg, {
        production: process.env.NODE_ENV === "production",
      });
      const tlsOpts = resolvedTls.tls ? { tls: resolvedTls.tls } : {};
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
        if (options.strictInit) {
          // Fail closed: never serve in a half-initialized state (e.g. a DB
          // connection failed at boot). Stop the listener so callers get
          // connection refused until the app is restarted with the issue fixed.
          console.error(
            "[ignex] strict init failed — stopping server; fix the failing plugin and restart.",
          );
          server?.stop(true);
          server = null;
        }
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
              ...tlsOpts,
              ...rest,
            }
          : {
              fetch: (req, srv) => handler(req, srv as IgnexServer | undefined),
              port,
              hostname,
              ...tlsOpts,
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
