/**
 * @fileoverview Debugbar plugin — the developer dashboard (composition root).
 *
 * A Laravel-debugbar-class observability layer that activates when **debug
 * mode is on** (`NODE_ENV === "development"` or `IGNEX_DEBUG=1`; an unset or
 * ambiguous environment stays OFF). This file owns OPTIONS and LIFECYCLE; the
 * serving layer lives in `debug/server/` (auth, assets, SSE stream, endpoint
 * table) and the SPA itself in `debug/ui/`.
 *
 * Feature map (details in docs/debugbar.md):
 * - **Request waterfall** — every request traced end-to-end (`ctx.debug`,
 *   `debugSpan`, `debugQuery`, …), replayable with one click.
 * - **Observatory** — structured logs, metrics/Prometheus, SQLite history,
 *   leak diagnostics, system profile, NATS/nova event tracking.
 * - **Live updates** — an SSE revision stream (`/api/stream`) pushes mutation
 *   counters so dashboards refetch only what changed (polling fallback).
 *
 * Dashboard + JSON API live under `{path}` (default `/__debugbar`), hidden
 * from OpenAPI and excluded from tracing. Production cost when debug is off:
 * a single boolean check per request.
 */

import { createDebugApi } from "../debug/api";
import { ClientRegistry } from "../debug/clients";
import { captureConsole, installLogStore, LogStore, uninstallLogStore } from "../debug/logs";
import { MetricsRegistry } from "../debug/metrics";
import { NatsEventTracker } from "../debug/nats-tracker";
import { ObservatoryDb } from "../debug/persist";
import { serverBaseUrl } from "../debug/replay";
import { json } from "../debug/respond";
import { createAssetServer } from "../debug/server/assets";
import { createTokenGate } from "../debug/server/auth";
import { createEndpointTable } from "../debug/server/endpoints";
import { createRevisionCounters } from "../debug/server/revisions";
import { createRouteFileIndex } from "../debug/server/route-index";
import { createStreamHub } from "../debug/server/stream";
import type { DataProviders, DebugbarState } from "../debug/server/types";
import { TraceStore } from "../debug/store";
import { SystemProfiler } from "../debug/system";
import { beginTrace, enterTraceContext, setTracingEnabled, type Trace } from "../debug/tracer";
import type { IgnexContext } from "../http/context";
import type { IgnexRouter } from "../http/router";
import { bootOrigin } from "../http/serve-boot";
import type { IgnexPlugin } from "../lifecycle/plugin";

/** Options for {@link debugbar}. */
export interface DebugbarOptions {
  /**
   * Master switch. Defaults to debug mode: `NODE_ENV === "development"` or
   * `IGNEX_DEBUG=1` — an unset/ambiguous environment (staging) is OFF by
   * default; set explicitly to force on/off.
   *
   * Production override: in a production process (`NODE_ENV=production`) or a
   * production-built artifact (compiler-baked `__IGNEX_PROD_BUILD`), the
   * plugin stays OFF unless `IGNEX_DEBUG=1` is also set — even an explicit
   * `enabled: true` cannot enable it there. This keeps stray `DEBUG=true`
   * env files from shipping a dev toolbar into production.
   */
  enabled?: boolean;
  /** Dashboard mount path. Default `/__debugbar`. */
  path?: string;
  /** Traces retained in memory (ring buffer). Default 500. */
  maxTraces?: number;
  /**
   * Total byte budget for captured request/response bodies across the trace
   * ring (default 32 MiB). When exceeded, the OLDEST traces shed their body
   * text first — spans, timings and metadata always survive.
   */
  maxBodyBytes?: number;
  /**
   * Capture request AND response bodies so the dashboard's Body tab (and
   * replay) show real payloads. Default true. Bodies are capped (256 KiB
   * each); only textual responses are captured (streams/SSE/binary skipped).
   */
  captureBody?: boolean;
  /** System sampling interval in ms; `0` disables sampling. Default 1000. */
  systemSampleMs?: number;
  /**
   * Optional access token. When set, every dashboard endpoint requires the
   * `x-debugbar-token` header or the path-scoped `__debugbar_token` cookie.
   * Visiting `{path}/?token=…` once performs the handshake: it validates the
   * token (constant-time), sets the HttpOnly cookie, and redirects to the
   * token-less path.
   */
  token?: string;
  /** AOT manifest.json location(s) for the KT route map. */
  manifestPaths?: string[];
  /** Published-SDK metadata probes (path to package.json / sdk.json). */
  sdkPaths?: string[];
  /**
   * Directories scanned for the KT documentation inventory. Default
   * `["docs", "."]` relative to {@link projectRoot}.
   */
  docsPaths?: string[];
  /** App root for the KT project map + docs scan. Default `process.cwd()`. */
  projectRoot?: string;
  /** Service name shown in the dashboard. Default `"ignex"`. */
  serviceName?: string;
  /** Service version shown in the dashboard. Default `"dev"`. */
  version?: string;
  /** Plugin inventory for the KT page (extend with your own plugins). */
  plugins?: string[];
  /** Extra data sources powering optional panels (jobs/routes/nova probes). */
  data?: DataProviders;
  /**
   * NATS event tracking for the Events panel (`url` defaults to `$NATS_URL`;
   * subjects/maxEvents/connect tuning).
   */
  nats?: {
    url?: string;
    subjects?: string[];
    maxEvents?: number;
    connect?: boolean;
  };
  /**
   * Extra frontend-client package probes for the Clients panel. Defaults probe
   * `dist/sdk` + `.ignex/sdk` plus anything `sdkPaths` points at.
   */
  clientPaths?: string[];
  /**
   * Explicit replay dispatcher, e.g. `(req) => app.handler(req)`. When unset,
   * replay uses the live Bun server's own URL (loopback fetch).
   */
  dispatch?: (req: Request) => Promise<Response>;
  /**
   * Structured log capture (Logs panel). Default on; `console: false` stops
   * mirroring console.* calls, `maxRecords` tunes the ring (default 2000).
   */
  logs?: {
    console?: boolean;
    maxRecords?: number;
  };
  /**
   * Local SQLite persistence (`.ignex/observatory.db`): traces/spans/logs/
   * samples survive restarts, powering the History panel. Default ON in debug
   * mode; pass `false` to disable or an object to tune path/flush/retention.
   */
  persist?:
    | boolean
    | {
        path?: string;
        flushIntervalMs?: number;
        maxAgeSec?: number;
        maxRows?: number;
      };
}

const DEBUG_KEY = Symbol.for("ignex.debugbar.trace");

/**
 * Build the debugbar plugin.
 *
 * ```ts
 * // src/app.config.ts
 * import { debugbar } from "@ignex/core";
 * export const plugins = [ debugbar() ];
 * ```
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: composition root — one wiring block per observatory subsystem
export const debugbar = (options: DebugbarOptions = {}): IgnexPlugin => {
  // Production guard (belt-and-suspenders with the compiler's build-time
  // elimination): a production process never boots the toolbar unless the
  // operator explicitly opted in via `IGNEX_DEBUG=1`. Covers both a prod
  // RUNTIME environment and a prod-SHAPED BUILD (`__IGNEX_PROD_BUILD`).
  const prodLocked =
    (process.env.NODE_ENV === "production" ||
      (globalThis as { __IGNEX_PROD_BUILD?: boolean }).__IGNEX_PROD_BUILD === true) &&
    process.env.IGNEX_DEBUG !== "1";
  if (prodLocked) {
    if (options.enabled === true) {
      console.warn(
        "[ignex] debugbar: disabled — NODE_ENV=production; set IGNEX_DEBUG=1 to explicitly enable",
      );
    }
    return {
      name: "debugbar",
      __ignexDevOnly: true,
    };
  }

  const path = options.path ?? "/__debugbar";
  const enabled =
    options.enabled ?? (process.env.IGNEX_DEBUG === "1" || process.env.NODE_ENV === "development");
  const captureBody = options.captureBody ?? true;

  // ── observatory wiring ────────────────────────────────────────────────────
  const revisions = createRevisionCounters();
  const logStore = new LogStore({
    ...(options.logs?.maxRecords !== undefined ? { maxRecords: options.logs.maxRecords } : {}),
    onNotify: (): void => revisions.bump("logs"),
  });
  const metrics = new MetricsRegistry();
  const store = new TraceStore({
    ...(options.maxTraces !== undefined ? { maxTraces: options.maxTraces } : {}),
    ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
    onNotify: (): void => revisions.bump("traces"),
  });

  const state: DebugbarState = {
    enabled,
    path,
    captureBody,
    token: options.token ?? null,
    store,
    profiler: new SystemProfiler({
      ...(options.systemSampleMs !== undefined ? { sampleMs: options.systemSampleMs } : {}),
      onSample: (sample): void => {
        metrics.observeSystem(sample);
        state.sink?.pushSample(sample);
        revisions.bump("system");
      },
    }),
    serviceName: options.serviceName ?? "ignex",
    version: options.version ?? "dev",
    manifestPaths: options.manifestPaths ?? [],
    sdkPaths: options.sdkPaths ?? [],
    docsPaths: options.docsPaths ?? [],
    projectRoot: options.projectRoot ?? process.cwd(),
    clientPaths: options.clientPaths ?? [],
    plugins: ["debugbar", ...(options.plugins ?? [])],
    active: new Map(),
    // Auto-enabled by $NATS_URL even without an explicit `nats` option.
    nats:
      options.nats !== undefined || process.env.NATS_URL
        ? new NatsEventTracker({ ...options.nats, onNotify: (): void => revisions.bump("events") })
        : null,
    clients: new ClientRegistry(),
    logs: logStore,
    metrics,
    sink: null,
    consoleRestore: null,
    router: null,
    closed: false,
    loopProbe: null,
    routeFiles: null,
    bootUrl: null,
    urlLogged: false,
  };

  const deps = {
    state,
    data: options.data,
    ...(options.dispatch !== undefined ? { dispatch: options.dispatch } : {}),
  };
  const gate = createTokenGate(state.token);
  const assets = createAssetServer(path);
  const streamHub = createStreamHub(revisions);
  const routeIndex = createRouteFileIndex(state.manifestPaths);
  const api = createEndpointTable(deps, routeIndex, streamHub);

  if (enabled) {
    setTracingEnabled(true);
    // Observatory logging installs with the FACTORY (not init): the process-
    // wide store must be live before any route runs, including in embedded
    // hosts that never fire the lifecycle's start stage.
    installLogStore(logStore);
  }

  // ── dashboard serving (AOT onRequest interception) ────────────────────────
  const serve = (pathname: string, ctx: IgnexContext): Response | Promise<Response> => {
    const rest = pathname.slice(state.path.length);
    if (rest === "") {
      return new Response(null, { status: 307, headers: { location: `${state.path}/` } });
    }
    if (rest.startsWith("/api/")) {
      const apiPath = rest.slice(5);
      if (isPublicApiPath(apiPath)) return api.dispatch(apiPath, ctx);
      if (!gate.authorized(ctx)) return json({ error: "forbidden" }, 403);
      return api.dispatch(apiPath, ctx);
    }
    // Everything non-API requires the normal gate first — EXCEPT the static
    // bundle assets, which carry no secrets (BASE/token are runtime-injected)
    // and whose availability before the cookie handshake keeps first-visit
    // flows simple across proxies. The page itself stays gated.
    if (rest === "/") {
      if (!gate.authorized(ctx)) {
        // Page handshake: `?token=…` rotates into an HttpOnly path-scoped
        // cookie so tokens never persist in API query strings or access logs.
        if (gate.hasQueryToken(ctx)) {
          return new Response(null, {
            status: 307,
            headers: {
              location: `${state.path}/`,
              "set-cookie": `${COOKIE_NAME}=${state.token}; Path=${state.path}; HttpOnly; SameSite=Strict; Max-Age=28800`,
            },
          });
        }
        return json({ error: "forbidden" }, 403);
      }
      return assets.page();
    }
    if (rest === "/app.js") return assets.js(ctx.headers.get("if-none-match"));
    if (rest === "/app.css") return assets.css(ctx.headers.get("if-none-match"));
    if (!gate.authorized(ctx)) return json({ error: "forbidden" }, 403);
    return json({ error: "not_found", status: 404 }, 404);
  };

  /** Endpoints that authenticate by mechanism instead of the standard gate. */
  const isPublicApiPath = (apiPath: string): boolean => {
    const head = apiPath.replace(/^\/+/, "").split("/")[0] ?? "";
    if (head === "stream") return true; // ticket auth inside the table
    void head;
    return false;
  };

  // ── interpreted mode: register dashboard routes on the router ─────────────
  const registerRoutes = (router: IgnexRouter): void => {
    state.router = router;
    const base = state.path.replace(/\/$/, "");
    router.get(base, () => new Response(null, { status: 302, headers: { location: `${base}/` } }));
    router.get(`${base}/`, () => assets.page());
    router.get(`${base}/app.js`, () => assets.js(null));
    router.get(`${base}/app.css`, () => assets.css(null));
    api.registerRoutes(router, base);
  };

  // ── request lifecycle ─────────────────────────────────────────────────────
  return {
    name: "debugbar",
    // Dev-only marker: compiled servers drop disabled dev-only plugins at boot
    // (and eliminate provably-disabled instances at build time).
    __ignexDevOnly: !enabled,

    init() {
      if (!state.enabled || state.closed) return;
      // The origin comes from the serve framework (protocol/port/hostname
      // resolved before plugin boot), so a plain-HTTP server logs http:// —
      // never a guessed https. Falls back to env heuristics outside a server.
      state.bootUrl = `${bootOrigin()}${state.path}/`;
      console.log(
        `[ignex] debugbar: ${state.bootUrl} — waterfall + replay, logs, metrics (Prometheus), leak diagnostics, SQLite history, NATS events, KT docs (debug mode)`,
      );

      if (options.logs?.console !== false && state.consoleRestore === null) {
        state.consoleRestore = captureConsole(state.logs);
      }
      const persistOption = options.persist;
      if (persistOption !== false) {
        void ObservatoryDb.create(persistOption === true ? {} : (persistOption ?? {})).then(
          (db) => {
            if (!db) return;
            state.sink = db;
            db.start();
          },
        );
      }
      state.profiler.start();
      state.nats?.start();
      const natsStatus = state.nats?.stats();
      if (natsStatus?.enabled === true) {
        console.log(
          `[ignex] debugbar: NATS events ${natsStatus.connected ? "connected" : `not connected (${natsStatus.status})`} at ${natsStatus.url} — subjects: ${natsStatus.subjects.join(", ")}`,
        );
      }
      // Event-loop delay probe: measure how late a 50ms timer fires.
      state.loopProbe = setInterval(() => {
        const expected = performance.now() + 50;
        const t = setTimeout(() => {
          state.profiler.recordEventLoopDelay(performance.now() - expected);
        }, 50);
        t.unref?.();
      }, 500);
      state.loopProbe.unref?.();
    },

    close() {
      if (state.closed) return;
      state.closed = true;
      if (state.loopProbe) {
        clearInterval(state.loopProbe);
        state.loopProbe = null;
      }
      state.profiler.stop();
      streamHub.stop();
      state.nats?.stop();
      state.consoleRestore?.();
      state.consoleRestore = null;
      uninstallLogStore();
      const sink = state.sink;
      if (sink) {
        state.sink = null;
        void sink.close();
      }
    },

    routes: registerRoutes,

    onRequest(ctx: IgnexContext): IgnexContext | Response | Promise<IgnexContext | Response> {
      // Debug mode off: the ONLY per-request cost of the whole feature.
      if (!state.enabled) return ctx;

      const pathname = ctx.url.pathname;

      if (isDashboardPath(state.path, pathname)) {
        if (state.router !== null) return ctx; // interpreted mode owns serving
        return serve(pathname, ctx);
      }

      const trace = beginTrace(ctx, state.captureBody);
      trace.observeStage("request");

      // First traced request: log the EXACT dashboard URL (real protocol/host).
      if (!state.urlLogged) {
        state.urlLogged = true;
        const base = serverBaseUrl(ctx.server);
        if (base) {
          const exact = `${base.replace(/\/$/, "")}${state.path}/`;
          if (exact !== state.bootUrl) console.log(`[ignex] debugbar: ${exact}`);
        }
      }

      // Swap the shared no-op `ctx.debug` for the real per-request API.
      Object.defineProperty(ctx, "debug", {
        value: createDebugApi(trace),
        configurable: true,
        writable: true,
      });
      ctx.setState(DEBUG_KEY, trace);
      enterTraceContext(trace);
      state.active.set(trace.id, trace);
      state.profiler.setActiveRequests(state.active.size);

      // Bound runaway active traces (never-finalized requests).
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
      // Await finalize so the store is consistent the moment the response is
      // observable (with captureBody this copies bodies — dev-mode only).
      const settled = state.captureBody
        ? captureResponseBody(trace, response)
        : Promise.resolve(response);
      return settled
        .then((res) =>
          finalizeAndStore(state, deps.data, revisions, trace, {
            status: res.status,
            responseHeaders: res.headers,
          }).then(() => res),
        )
        .catch(() => response);
    },

    onError(error: Error, ctx: IgnexContext): Response | undefined | Promise<Response | undefined> {
      if (!state.enabled) return undefined;
      let trace = ctx.getState<Trace>(DEBUG_KEY);
      if (!trace) {
        // Error path with no prior onRequest: capture the failure anyway.
        trace = beginTrace(ctx, false);
        trace.observeStage("error");
        ctx.setState(DEBUG_KEY, trace);
        enterTraceContext(trace);
        state.active.set(trace.id, trace);
        state.profiler.setActiveRequests(state.active.size);
      }
      // Record the error's REAL status (validation 422 ≠ crash 500 — keeps
      // status-family filters and AI summaries truthful).
      const status =
        typeof (error as unknown as { status?: unknown }).status === "number"
          ? (error as unknown as { status: number }).status
          : 500;
      return finalizeAndStore(state, deps.data, revisions, trace, {
        status,
        responseHeaders: null,
        error,
      }).then(() => undefined);
    },
  };
};

/* ── helpers ────────────────────────────────────────────────────────────────── */

const COOKIE_NAME = "__debugbar_token";

/** True when the request path is under the dashboard mount. */
const isDashboardPath = (mountPath: string, pathname: string): boolean =>
  pathname === mountPath || pathname.startsWith(`${mountPath}/`);

// ── response body capture ─────────────────────────────────────────────────────

/** Responses that never carry a body — reading them would be pointless. */
const BODYLESS_STATUS = new Set([204, 205, 304]);

/** Upper bound for a captured response body (avoid buffering giant payloads). */
const MAX_RESPONSE_CAPTURE_BYTES = 1_048_576; // 1 MiB

/**
 * True when the content type is a textual payload worth showing in the Body
 * tab. Streams are excluded FIRST (text/event-stream is infinite), then binary
 * containers, then a positive list of text families (+json/+xml included).
 */
const isCapturableContentType = (contentType: string | null): boolean => {
  if (!contentType) return true;
  const c = contentType.toLowerCase();
  if (
    c.includes("event-stream") ||
    c.includes("octet-stream") ||
    c.includes("grpc") ||
    c.startsWith("multipart/") ||
    c.startsWith("image/") ||
    c.startsWith("audio/") ||
    c.startsWith("video/")
  ) {
    return false;
  }
  return (
    /^(text\/|application\/(json|javascript|xml|xhtml|graphql|ld\+json|urlencoded|form-urlencoded))/.test(
      c,
    ) ||
    c.includes("+json") ||
    c.includes("+xml")
  );
};

/**
 * Capture a textual response body onto the trace WITHOUT breaking the
 * response: consumed deterministically, then rebuilt identically. (Cloning +
 * awaiting cannot work here — the clone only drains while someone reads the
 * original, which stalls every traced request against a dead tee.)
 */
const captureResponseBody = async (trace: Trace, response: Response): Promise<Response> => {
  if (BODYLESS_STATUS.has(response.status) || response.body === null) return response;
  if (!isCapturableContentType(response.headers.get("content-type"))) return response;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_CAPTURE_BYTES) {
    return response;
  }
  try {
    const text = await response.text();
    trace.setResponseBody(text);
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    return response;
  }
};

/** Finalize a trace exactly once; update stores, metrics, persistence. */
const finalizeAndStore = async (
  state: DebugbarState,
  data: DataProviders | undefined,
  revisions: ReturnType<typeof createRevisionCounters>,
  trace: Trace,
  input: { status: number; responseHeaders: Headers | null; error?: unknown },
): Promise<void> => {
  void data;
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
    // Metrics + persistence see EVERY finalized request (not just the ones
    // the bounded trace ring still retains).
    state.metrics.observeRequest({
      method: finished.method,
      routeKey: `${finished.method} ${finished.route || finished.path}`,
      status: finished.status,
      durationMs: finished.durationMs,
      error: Boolean(finished.error),
      dbQueries: finished.dbCount,
      dbMs: finished.dbTimeMs,
    });
    revisions.bump("metrics");
    state.sink?.pushTrace(finished);
  }
};
