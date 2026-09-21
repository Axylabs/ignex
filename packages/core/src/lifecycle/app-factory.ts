/**
 * @fileoverview Ignex App Factory - Core application creation and composition
 *
 * This module contains the `createApp` function and the `IgnexApp` interface.
 * It orchestrates plugin integration, lifecycle setup, and request handling.
 * The app factory is the primary public API for building Ignex applications.
 */

import { initNative, warmRuntime } from "@ignex/native";
import { HttpResponseCache } from "../data/cache";
import {
  type ContextOptions,
  createContext,
  type IgnexContext,
  type IgnexServer,
} from "../http/context";
import type { IgnexRouter } from "../http/router";
import { setServeBootInfo } from "../http/serve-boot";
import { resolveServeTls, type ServerProtocolConfig, type ServerTlsConfig } from "../http/tls";
import { errorToResponse } from "../platform/errors";
import { installProcessGuards } from "../platform/process-guards";
import type { LifeCycleStore, MaybePromise } from "../types";
import { mergeLifeCycle } from "./hooks";
import {
  collectContextOptions,
  collectResponseDefaults,
  createPluginContext,
  type IgnexPlugin,
  pluginContextToLifecycle,
  pluginsToLifeCycle,
} from "./plugin";
import { buildPostStages, buildPreStages, runLifecycle } from "./run";
import { resolveServeLimits } from "./serve";

/**
 * Default maximum time `IgnexApp.stop` waits for plugin `close()` hooks
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
  /**
   * Advisory per-request header-size ceiling in bytes; see
   * {@link ContextOptions.maxHeaderBytes}. Unset by default — Bun's
   * socket-level header limits stay the authority unless an app opts in.
   */
  maxHeaderBytes?: number;
}

/**
 * Options for {@link IgnexApp.serve}.
 */
export type ServeOptions = Record<string, unknown> & {
  port?: number;
  hostname?: string;
  /** Serve HTTPS over TLS. Default `true`; set `false` for plain HTTP/1. */
  https?: boolean;
  /**
   * Serve HTTP/2 alongside HTTP/1.1 on the TLS port (ALPN). Requires TLS;
   * maps to Bun.serve's `http2` option (Bun ≥1.4.1). `http2` is accepted as
   * an alias.
   */
  h2?: boolean;
  /** Alias of `h2` matching Bun.serve's option name (`http2: true`). */
  http2?: boolean;
  /** TLS cert/key file paths. Omit in dev to auto-generate local certs. */
  tls?: ServerTlsConfig;
  /** Directory for generated dev certs (default `.ignex/certs`). */
  certDir?: string;
};

/**
 * Default per-request body ceiling (bytes) applied by `serve()` when the app
 * does not configure `maxRequestBodySize`. 64MB comfortably covers the
 * framework's default 20MB single-file upload limit while capping the memory
 * an adversarial chunked request can pin per connection.
 */
export const DEFAULT_MAX_REQUEST_BODY_SIZE = 64 * 1024 * 1024;

/**
 * Default WebSocket frame ceiling (bytes) injected when an app configures a
 * `websocket` handler without its own `maxPayloadLength`. Bun's implicit
 * default is far larger than typical message workloads need.
 */
export const DEFAULT_WS_MAX_PAYLOAD_LENGTH = 4 * 1024 * 1024;

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
 * Resolve this app's `trustProxy` setting, or `undefined` when nothing sets it.
 *
 * An explicit app-level option wins; otherwise a plugin's declaration applies
 * (see `IgnexPlugin.contextOptions`, which `security({ trustProxy: true })` now
 * carries). Either way the value has to equal what the compiled server folds
 * into its frozen context-options literal, or `ctx.ip` would resolve
 * differently in a compiled build than in an interpreted one. Extracted from
 * `createApp`, which sits at the cognitive-complexity ceiling.
 *
 * @param options - The app options the app was created with.
 * @returns The setting, or `undefined` to leave it unset.
 */
const resolveTrustProxy = (options: AppOptions): boolean | undefined => {
  if (options.trustProxy !== undefined) return options.trustProxy;
  return collectContextOptions(options.plugins ?? [])?.trustProxy;
};

/**
 * Populate the app-invariant context options once at `createApp` time.
 *
 * Kept OUT of `createApp` (which sits at the cognitive-complexity ceiling):
 * cache, proxy trust and the advisory `maxHeaderBytes` gate are all fixed at
 * creation and must stay out of the per-request hot path.
 *
 * @param options - The app options the app was created with.
 * @param appCache - The app-scoped response cache.
 * @returns The pre-computed context options for every request the app serves.
 */
const buildContextOptions = (options: AppOptions, appCache: HttpResponseCache): ContextOptions => {
  const ctxOptions: ContextOptions = { cache: appCache };
  const trustProxy = resolveTrustProxy(options);
  if (trustProxy !== undefined) ctxOptions.trustProxy = trustProxy;
  if (options.maxHeaderBytes !== undefined) ctxOptions.maxHeaderBytes = options.maxHeaderBytes;
  return ctxOptions;
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
  // cache in http/context/impl.ts).
  const appCache = options.cache ?? new HttpResponseCache();

  // exactOptionalPropertyTypes: only set optional fields that are defined.
  // The context options are app-invariant (cache + trustProxy + header cap are
  // fixed at createApp time), so they are computed ONCE instead of per request.
  const ctxOptions = buildContextOptions(options, appCache);

  // App-invariant response headers declared by plugins (e.g. the `security()`
  // header set). Baked into every framework-built response at construction so
  // the plugin never has to mutate the finished `Response` — computed once
  // here, not per request. `undefined` when no plugin declares any, which
  // keeps `withBody`'s fast path branch-free.
  const responseDefaults = collectResponseDefaults(options.plugins ?? []);
  if (responseDefaults !== undefined) ctxOptions.responseDefaults = responseDefaults;

  const init = async (): Promise<void> => {
    if (initialized) return;
    initialized = true;
    // Eagerly pre-warm the Rust addon (rayon pool + dlopen) at boot instead
    // of lazily on the first request. Load-time cost is acceptable; runtime
    // latency is not. No-op without the addon.
    initNative();
    // Force the C-ABI bind + parity self-test NOW (not inside the first
    // request): previously ~40 lazy assertions ran on the first post-deploy
    // request, adding a one-off latency spike to it. Idempotent + safe.
    warmRuntime();
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

    let ctx: IgnexContext;
    try {
      ctx = createContext(req, {}, ctxOptions);
    } catch (err) {
      // createContext can reject before request state exists (advisory
      // `maxHeaderBytes` gate, future pre-context guards). No lifecycle to
      // run — convert straight to the error envelope so `handler()` fulfills
      // with a Response instead of rejecting into a 500.
      return Promise.resolve(errorToResponse(err, exposeErrors));
    }
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
      const {
        port = 3000,
        hostname = "0.0.0.0",
        https,
        h2,
        http2,
        tls,
        certDir,
        idleTimeout,
        maxRequestBodySize,
        websocket,
        ...rest
      } = serveOptions;
      const resolvedLimits = resolveServeLimits({ idleTimeout, maxRequestBodySize, websocket });
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
      // Publish the resolved origin BEFORE plugin init hooks run so plugin
      // boot logs (debugbar, openapi) print scheme-correct URLs.
      setServeBootInfo({ protocol: resolvedTls.protocol, port, hostname });
      const tlsOpts = resolvedTls.tls ? { tls: resolvedTls.tls } : {};
      // HTTP/2 (alias `h2`/`http2`) requires TLS and maps to Bun.serve's
      // `http2` option — Bun ≥1.4.1 negotiates h2 over the TLS port via ALPN.
      // Only ever set alongside TLS (parity with the AOT-compiled bootstrap).
      const http2Opt = (http2 ?? h2) === true && resolvedTls.tls ? { http2: true } : {};
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
            idleTimeout: resolvedLimits.idleTimeout,
            maxRequestBodySize: resolvedLimits.maxRequestBodySize,
            ...(resolvedLimits.websocket !== undefined
              ? { websocket: resolvedLimits.websocket }
              : {}),
            ...http2Opt,
            ...tlsOpts,
            ...rest,
          }
        : {
            fetch: (req: Request, srv: unknown) => handler(req, srv as IgnexServer | undefined),
            port,
            hostname,
            idleTimeout: resolvedLimits.idleTimeout,
            maxRequestBodySize: resolvedLimits.maxRequestBodySize,
            ...(resolvedLimits.websocket !== undefined
              ? { websocket: resolvedLimits.websocket }
              : {}),
            ...http2Opt,
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
