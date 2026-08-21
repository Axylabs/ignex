/**
 * Application lifecycle — programmatic app composition with graceful shutdown.
 *
 * `createApp` composes plugins + a lifecycle into a request `handler` that
 * runs the same hook semantics as the compiler-generated server
 * (`__runHooks`: a hook may return a `Response` to halt, `{ response }` to
 * halt, or `{ ctx }` to continue with a new context). `serve` wraps
 * `Bun.serve`; `stop` drains and runs `onStop`/`stop` hooks.
 *
 * The per-request machinery (`runHooks`, `runLifecycle`, the stage builders)
 * lives in `./run` — this module owns the app factory and re-exports the
 * pipeline so the public surface is unchanged.
 */
import { initNative } from "@ignex/native";
import { HttpResponseCache } from "../data/cache";
import {
  type ContextOptions,
  createContext,
  type IgnexContext,
  type IgnexServer,
} from "../http/context";
import type { IgnexRouter } from "../http/router";
import { resolveServeTls, type ServerProtocolConfig, type ServerTlsConfig } from "../http/tls";
import { installProcessGuards } from "../platform/process-guards";
import type { LifeCycleStore, MaybePromise } from "../types";
import { mergeLifeCycle } from "./hooks";
import {
  createPluginContext,
  type IgnexPlugin,
  pluginContextToLifecycle,
  pluginsToLifeCycle,
} from "./plugin";
import { buildPostStages, buildPreStages, runLifecycle } from "./run";

export {
  buildPostStages,
  buildPreStages,
  POST_HANDLER_STAGES,
  PRE_HANDLER_STAGES,
  type RunHooksResult,
  runHooks,
  runLifecycle,
} from "./run";

/**
 * Default maximum time {@link IgnexApp.stop} waits for plugin `close()` hooks
 * before giving up — a stuck close (never-resolving promise, leaked socket)
 * must not hang graceful shutdown forever (matches the job-queue deadline).
 */
const STOP_DEADLINE_MS = 5_000;

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
  /** Enable HTTP/2 (requires TLS). Opt-in; default HTTP/1.1. */
  h2?: boolean;
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
  stop(options?: { closeActive?: boolean; stopDeadlineMs?: number }): Promise<void>;
  readonly lifecycle: LifeCycleStore;
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

      const serveOpts = router
        ? {
            // Routed apps use Bun's native route table (Rust path/method
            // matching) with the router's fallback for 404/405/OPTIONS —
            // the same shape as the AOT-compiled server.
            routes: router.buildRoutes(),
            fetch: (req: Request, srv: unknown) =>
              router.fetch(req, srv as IgnexServer | undefined),
            port,
            hostname,
            ...tlsOpts,
            ...rest,
          }
        : {
            fetch: (req: Request, srv: unknown) => handler(req, srv as IgnexServer | undefined),
            port,
            hostname,
            ...tlsOpts,
            ...rest,
          };

      // Bind the listener once (guard against double-bind when onStart is
      // async and resolves later). `server` stays the single source of truth
      // for the bound instance.
      const bind = (): unknown => {
        if (server) return server;
        server = serve(serveOpts);
        return server;
      };

      // Run onStart BEFORE the listener accepts traffic so a slow onStart
      // (DB connect / warmup) never races the first requests. When onStart is
      // async, binding is deferred until it resolves; its failure is logged,
      // never fatal.
      const bindAfterOnStart = (): unknown => {
        try {
          const r = options.onStart?.();
          if (r && typeof (r as Promise<void>).then === "function") {
            void (r as Promise<void>)
              .catch((err) => {
                console.error("[ignex] onStart failed:", err);
              })
              .then(() => bind());
          } else {
            bind();
          }
        } catch (err) {
          console.error("[ignex] onStart failed:", err);
          bind();
        }
        return server;
      };

      if (options.strictInit) {
        // Fail CLOSED: never bind the listener unless every plugin
        // initialized. `init()` rejects (see `initAll`) so a failing plugin
        // (e.g. a DB connection at boot) means the app serves nothing and
        // callers get connection refused until it is restarted with the
        // issue fixed.
        void init()
          .then(() => {
            bindAfterOnStart();
          })
          .catch((err) => {
            console.error(
              "[ignex] strict init failed — not starting server; fix the failing plugin and restart.",
              err,
            );
          });
        return server;
      }

      // Best-effort (default): bind immediately; a rejected init is logged
      // but never crashes or stops a serving app (plugin `close` on shutdown
      // is unaffected).
      void init().catch((err) => {
        console.error("[ignex] plugin init failed:", err);
      });
      return bindAfterOnStart();
    },

    async stop(stopOptions: { closeActive?: boolean; stopDeadlineMs?: number } = {}) {
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
      // Plugin close() must never hang graceful shutdown forever: give it a
      // hard deadline and resolve anyway (matches the job-queue stop deadline).
      const deadline = Date.now() + (stopOptions.stopDeadlineMs ?? STOP_DEADLINE_MS);
      await Promise.race([
        pluginContext.closeAll(),
        new Promise((resolve) => {
          const t = setTimeout(resolve, Math.max(0, deadline - Date.now()));
          t.unref?.();
        }),
      ]);
    },
  };
};
