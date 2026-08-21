/**
 * @fileoverview Debugbar plugin — the developer dashboard.
 *
 * A Laravel-debugbar-class observability layer that activates when **debug
 * mode is on** (`NODE_ENV !== "production"` or `IGNEX_DEBUG=1`):
 *
 * - **Request waterfall** — every request is traced end-to-end: lifecycle
 *   stages, the handler, and every span recorded through `ctx.debug` or the
 *   ALS-propagated free helpers (`debugSpan`, `debugQuery`, … from
 *   `@ignex/core/debug`). DB queries get their own rows with exact timing, so
 *   the bottleneck in any slow request is visible at a glance.
 * - **Errors + replay** — every error (handler throw, hook failure, 5xx) is
 *   captured with its stack; any stored request can be **replayed** through
 *   the server with one click.
 * - **System profile** — CPU, RSS, heap and event-loop delay are sampled and
 *   charted, alongside request totals (avg / p95 duration, error count).
 * - **SDK list + KT** — published-SDK metadata (from `ignex sdk` artifacts)
 *   and a generated "how this app works" knowledge page: route map, plugins,
 *   lifecycle stages, span kinds, environment — so new developers don't need
 *   a hand-off document.
 *
 * Dashboard + JSON API live under `{path}` (default `/__debugbar`). The
 * endpoints are hidden from OpenAPI and excluded from tracing. Production
 * (debug off) cost is a single boolean check per request.
 */

import { createDebugApi } from "../debug/api";
import { DEBUGBAR_DASHBOARD_HTML, DEBUGBAR_DASHBOARD_JS } from "../debug/dashboard";
import { buildAppKnowledge, formatKnowledgeMarkdown } from "../debug/kt";
import { replayRequest, serverBaseUrl } from "../debug/replay";
import { html, json, notFound } from "../debug/respond";
import { TraceStore } from "../debug/store";
import { SystemProfiler } from "../debug/system";
import {
  beginTrace,
  enterTraceContext,
  redactRequestTrace,
  setTracingEnabled,
  type Trace,
} from "../debug/tracer";
import type { AppKnowledge, KnowledgeOptions, SystemStats } from "../debug/types";
import type { IgnexContext } from "../http/context";
import type { IgnexRouter } from "../http/router";
import type { IgnexPlugin } from "../lifecycle/plugin";

/** Options for {@link debugbar}. */
export interface DebugbarOptions {
  /**
   * Master switch. Defaults to debug mode: `NODE_ENV !== "production"` or
   * `IGNEX_DEBUG=1`. Set explicitly to force on/off (e.g. a staging box).
   */
  enabled?: boolean;
  /** Dashboard mount path. Default `/__debugbar`. */
  path?: string;
  /** Traces retained in memory (ring buffer). Default 500. */
  maxTraces?: number;
  /**
   * Capture request bodies (needed to replay requests with a body). Default
   * false — bodies are buffered per request and cost memory.
   */
  captureBody?: boolean;
  /** System sampling interval in ms; `0` disables sampling. Default 1000. */
  systemSampleMs?: number;
  /**
   * Optional access token. When set, every dashboard endpoint except the
   * static JS asset requires `?token=` (or the `x-debugbar-token` header).
   */
  token?: string;
  /** AOT manifest.json location(s) for the KT route map. */
  manifestPaths?: string[];
  /** Published-SDK metadata probes (path to package.json / sdk.json). */
  sdkPaths?: string[];
  /** Service name shown in the dashboard. Default `package.json` name or "ignex". */
  serviceName?: string;
  /** Service version shown in the dashboard. Default "dev". */
  version?: string;
  /** Plugin inventory for the KT page (extend with your own plugins). */
  plugins?: string[];
  /**
   * Explicit replay dispatcher, e.g. `(req) => app.handler(req)`. When set,
   * replay re-issues the stored request through it (most faithful: same
   * process, full pipeline). When unset, replay uses the live Bun server's
   * own URL (loopback fetch, permissive TLS) so the native route table runs.
   */
  dispatch?: (req: Request) => Promise<Response>;
}

const DEBUG_KEY = Symbol.for("ignex.debugbar.trace");

interface PluginState {
  readonly enabled: boolean;
  readonly path: string;
  readonly captureBody: boolean;
  readonly token: string | null;
  readonly store: TraceStore;
  readonly profiler: SystemProfiler;
  readonly serviceName: string;
  readonly version: string;
  readonly manifestPaths: string[];
  readonly sdkPaths: string[];
  readonly plugins: string[];
  readonly active: Map<string, Trace>;
  router: IgnexRouter | null;
  /** Known to be "ignex:debugbar" so close() stops the profiler once. */
  closed: boolean;
  /** Best-effort dashboard URL logged at init (protocol/port may be refined later). */
  bootUrl: string | null;
  /** Set once the exact URL has been logged (first traced request). */
  urlLogged: boolean;
}

/** True when the request's URL path is under the dashboard mount. */
const isDebugbarPath = (state: PluginState, pathname: string): boolean =>
  pathname === state.path || pathname.startsWith(`${state.path}/`);

/** Token gate (applies to everything except the static JS asset). */
const authorized = (state: PluginState, ctx: IgnexContext): boolean => {
  if (!state.token) return true;
  const header = ctx.headers.get("x-debugbar-token");
  if (header === state.token) return true;
  return ctx.url.searchParams.get("token") === state.token;
};

/**
 * Build the debugbar plugin.
 *
 * ```ts
 * // src/app.config.ts
 * import { debugbar } from "@ignex/core";
 * export const plugins = [ debugbar() ];
 * ```
 */
export const debugbar = (options: DebugbarOptions = {}): IgnexPlugin => {
  const path = options.path ?? "/__debugbar";
  const enabled =
    options.enabled ?? (process.env.IGNEX_DEBUG === "1" || process.env.NODE_ENV !== "production");
  const captureBody = options.captureBody ?? false;
  const token = options.token ?? null;

  const storeOptions: { maxTraces?: number } = {};
  if (options.maxTraces !== undefined) storeOptions.maxTraces = options.maxTraces;
  const profilerOptions: { sampleMs?: number } = {};
  if (options.systemSampleMs !== undefined) profilerOptions.sampleMs = options.systemSampleMs;

  const state: PluginState = {
    enabled,
    path,
    captureBody,
    token,
    store: new TraceStore(storeOptions),
    profiler: new SystemProfiler(profilerOptions),
    serviceName: options.serviceName ?? "ignex",
    version: options.version ?? "dev",
    manifestPaths: options.manifestPaths ?? [],
    sdkPaths: options.sdkPaths ?? [],
    plugins: ["debugbar", ...(options.plugins ?? [])],
    active: new Map(),
    router: null,
    closed: false,
    bootUrl: null,
    urlLogged: false,
  };

  if (enabled) {
    setTracingEnabled(true);
  }

  // ── dashboard serving (shared by the AOT onRequest interception and the
  //    interpreted router routes) ──────────────────────────────────────────

  const serve = async (pathname: string, ctx: IgnexContext): Promise<Response> => {
    const rest = pathname.slice(state.path.length);
    if (rest === "") {
      // `{path}` without a trailing slash: redirect so relative URLs (the JS
      // fetching `./api/...`) resolve against `{path}/`.
      return new Response(null, {
        status: 307,
        headers: { location: `${state.path}/` },
      });
    }
    if (rest === "/") {
      if (!authorized(state, ctx)) return json({ error: "forbidden" }, 403);
      const base = state.path.replace(/\/$/, "");
      return html(DEBUGBAR_DASHBOARD_HTML.replaceAll("__BASE__", base));
    }
    if (rest === "/app.js") {
      const js = DEBUGBAR_DASHBOARD_JS.replace(
        'var BASE = document.currentScript ? document.currentScript.getAttribute("data-base") || "." : ".";',
        `var BASE = ${JSON.stringify(state.path)};`,
      );
      return html(js, 200);
    }
    if (rest.startsWith("/api/")) {
      if (!authorized(state, ctx)) return json({ error: "forbidden" }, 403);
      return serveApi(rest.slice(5), ctx);
    }
    return notFound();
  };

  const ktData = async (): Promise<{ markdown: string; knowledge: AppKnowledge }> => {
    const knowledgeOptions: KnowledgeOptions & { router?: IgnexRouter } = {
      serviceName: state.serviceName,
      version: state.version,
      manifestPaths: state.manifestPaths,
      sdkPaths: state.sdkPaths,
      plugins: state.plugins,
      lifecycle: {
        start: 0,
        request: 1,
        parse: 0,
        transform: 0,
        beforeHandle: 0,
        handler: 1,
        afterHandle: 1,
        mapResponse: 0,
        afterResponse: 0,
        error: 1,
      },
    };
    if (state.router) knowledgeOptions.router = state.router;
    const knowledge = await buildAppKnowledge(knowledgeOptions);
    return { markdown: formatKnowledgeMarkdown(knowledge), knowledge };
  };

  const serveApi = async (apiPath: string, ctx: IgnexContext): Promise<Response> => {
    // GET {path}/api/meta
    if (apiPath === "meta") {
      return json({
        serviceName: state.serviceName,
        version: state.version,
        environment: process.env.NODE_ENV ?? "development",
        debugMode: state.enabled,
        path: state.path,
      });
    }

    // GET {path}/api/requests?limit=&error=
    if (apiPath === "requests") {
      const url = ctx.url;
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const errorOnly = url.searchParams.get("error") === "1";
      return json(
        state.store.summaries({
          errorOnly,
          limit: Number.isFinite(limit) ? limit : 100,
        }),
      );
    }

    // GET {path}/api/requests/clear
    if (apiPath === "requests/clear") {
      state.store.clear();
      return json({ ok: true, cleared: true });
    }

    // GET {path}/api/requests/:id/replay
    const replayMatch = apiPath.match(/^requests\/([^/]+)\/replay$/);
    if (replayMatch && ctx.method === "POST") {
      return replayRequest(state.store, decodeURIComponent(replayMatch[1]), ctx, options.dispatch);
    }

    // GET {path}/api/requests/:id
    const idMatch = apiPath.match(/^requests\/([^/]+)$/);
    if (idMatch) {
      const trace = state.store.get(decodeURIComponent(idMatch[1]));
      return trace ? json(redactRequestTrace(trace)) : json({ error: "not_found" }, 404);
    }

    // GET {path}/api/system
    if (apiPath === "system") {
      const p = state.store.percentiles();
      const stats: SystemStats = state.profiler.stats({
        requests: state.store.size,
        errors: state.store.errorCount,
        avgMs: p.avgMs,
        p95Ms: p.p95Ms,
      });
      return json(stats);
    }

    // GET {path}/api/kt
    if (apiPath === "kt") {
      return json(await ktData());
    }

    // GET {path}/api/sdks
    if (apiPath === "sdks") {
      const { knowledge } = await ktData();
      return json({ sdk: knowledge.sdk });
    }

    return notFound();
  };

  // ── interpreted mode: register the dashboard routes on the router ───────

  const registerRoutes = (router: IgnexRouter): void => {
    state.router = router;
    router.get(path, () => new Response(null, { status: 302, headers: { location: `${path}/` } }));
    router.get(`${path}/`, () => html(DEBUGBAR_DASHBOARD_HTML.replaceAll("__BASE__", path)));
    router.get(`${path}/app.js`, () => html(DEBUGBAR_DASHBOARD_JS));
    router.get(`${path}/api/meta`, (ctx) => serveApi("meta", ctx));
    router.get(`${path}/api/requests`, (ctx) => serveApi("requests", ctx));
    router.get(`${path}/api/requests/clear`, (ctx) => serveApi("requests/clear", ctx));
    router.get(`${path}/api/system`, (ctx) => serveApi("system", ctx));
    router.get(`${path}/api/kt`, async (ctx) => serveApi("kt", ctx));
    router.get(`${path}/api/sdks`, async (ctx) => serveApi("sdks", ctx));
    router.get(`${path}/api/requests/:id`, (ctx) => {
      const trace = state.store.get(ctx.params.id);
      return trace ? json(redactRequestTrace(trace)) : json({ error: "not_found" }, 404);
    });
    router.post(`${path}/api/requests/:id/replay`, (ctx) =>
      replayRequest(state.store, ctx.params.id, ctx, options.dispatch),
    );
  };

  // ── request lifecycle ───────────────────────────────────────────────────

  return {
    name: "debugbar",
    // Dev-only marker: the compiled server drops disabled dev-only plugins
    // from the lifecycle at boot, so a production artifact with `debugbar()`
    // registered pays ZERO per-request hook costs (the compiler additionally
    // eliminates provably-disabled instances at build time, restoring
    // constant hoisting + context specialization).
    __ignexDevOnly: !enabled,

    init() {
      if (!state.enabled || state.closed) return;
      // Log the dashboard URL so developers see where to open it right at
      // boot. The scheme/port are a best effort (the framework serves HTTPS
      // by default in dev and falls back to HTTP when no certs are found in
      // production); the exact URL is logged on the first traced request.
      const port = process.env.PORT ?? "3000";
      const scheme = process.env.NODE_ENV === "production" ? "http" : "https";
      state.bootUrl = `${scheme}://localhost:${port}${state.path}/`;
      console.log(
        `[ignex] debugbar: ${state.bootUrl} — request waterfall, DB timing, errors + replay, system profile, KT docs (debug mode)`,
      );
      state.profiler.start();
      // Event-loop delay probe: measure how late a 50ms timer fires.
      const probe = setInterval(() => {
        const expected = performance.now() + 50;
        const t = setTimeout(() => {
          state.profiler.recordEventLoopDelay(performance.now() - expected);
        }, 50);
        t.unref?.();
      }, 500);
      probe.unref?.();
    },

    close() {
      if (state.closed) return;
      state.closed = true;
      state.profiler.stop();
    },

    routes: registerRoutes,

    onRequest(ctx: IgnexContext): IgnexContext | Response | Promise<IgnexContext | Response> {
      // Debug mode off: the ONLY per-request cost of the whole feature.
      if (!state.enabled) return ctx;

      const pathname = ctx.url.pathname;

      // Serve the dashboard itself (AOT mode; the router path handles
      // interpreted apps and skips interception entirely).
      if (isDebugbarPath(state, pathname)) {
        if (state.router) return ctx;
        return serve(pathname, ctx);
      }

      // Begin a trace for this request and seed the ALS so any code in the
      // request's async chain can record spans via the free helpers.
      const trace = beginTrace(ctx, state.captureBody);
      trace.observeStage("request");

      // First traced request: log the EXACT dashboard URL (real protocol,
      // host and port from the bound Bun server) when it differs from the
      // boot-time hint — e.g. a custom hostname, `port: 0` or `https: false`.
      if (!state.urlLogged) {
        state.urlLogged = true;
        const base = serverBaseUrl(ctx.server);
        if (base) {
          const exact = `${base.replace(/\/$/, "")}${state.path}/`;
          if (exact !== state.bootUrl) {
            console.log(`[ignex] debugbar: ${exact}`);
          }
        }
      }

      // Swap the shared no-op `ctx.debug` (prototype getter) for the real
      // per-request API. defineProperty creates an own property — debug-mode
      // only; production contexts keep the zero-cost prototype getter.
      Object.defineProperty(ctx, "debug", {
        value: createDebugApi(trace),
        configurable: true,
        writable: true,
      });
      ctx.setState(DEBUG_KEY, trace);
      enterTraceContext(trace);
      state.active.set(trace.id, trace);
      state.profiler.setActiveRequests(state.active.size);

      // Bound runaway active traces (never-finalized requests): force-close
      // the oldest so memory stays flat.
      if (state.active.size > 2000) {
        const oldest = state.active.values().next().value as Trace | undefined;
        if (oldest) {
          state.active.delete(oldest.id);
          void oldest.finalize({ status: 0, responseHeaders: null, captureBody: false });
        }
      }
      return ctx;
    },

    onResponse(ctx: IgnexContext, response: Response): Response | Promise<Response> {
      if (!state.enabled) return response;
      const trace = ctx.getState<Trace>(DEBUG_KEY);
      if (!trace) return response;
      // Await the finalize so the store is consistent the moment the response
      // is observable (with captureBody this copies the body — dev-mode only).
      return finalizeAndStore(state, trace, {
        status: response.status,
        responseHeaders: response.headers,
      }).then(() => response);
    },

    onError(error: Error, ctx: IgnexContext): Response | undefined | Promise<Response | undefined> {
      if (!state.enabled) return undefined;
      let trace = ctx.getState<Trace>(DEBUG_KEY);
      if (!trace) {
        // Error path with no prior onRequest (e.g. a wrapped-route rejection):
        // build a minimal trace so the failure is still captured.
        trace = beginTrace(ctx, false);
        trace.observeStage("error");
        ctx.setState(DEBUG_KEY, trace);
        enterTraceContext(trace);
        state.active.set(trace.id, trace);
        state.profiler.setActiveRequests(state.active.size);
      }
      return finalizeAndStore(state, trace, {
        status: 500,
        responseHeaders: null,
        error,
      }).then(() => undefined);
    },
  };
};

/** Finalize a trace exactly once, store it and update the profiler count. */
const finalizeAndStore = async (
  state: PluginState,
  trace: Trace,
  input: {
    status: number;
    responseHeaders: Headers | null;
    error?: unknown;
  },
): Promise<void> => {
  const finished = await trace.finalize({
    status: input.status,
    responseHeaders: input.responseHeaders,
    error: input.error,
    captureBody: state.captureBody,
  });
  state.active.delete(trace.id);
  state.profiler.setActiveRequests(state.active.size);
  if (finished.status !== 0 || finished.error) {
    state.store.push(finished);
  }
};
