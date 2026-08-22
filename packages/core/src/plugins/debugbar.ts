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

import { isNativeAvailable } from "@ignex/native";
import { createDebugApi } from "../debug/api";
import { ClientRegistry, type PublishedClient } from "../debug/clients";
import {
  DEBUGBAR_DASHBOARD_CSS,
  DEBUGBAR_DASHBOARD_HTML,
  DEBUGBAR_DASHBOARD_JS,
} from "../debug/dashboard";
import { buildAppKnowledge, formatKnowledgeMarkdown } from "../debug/kt";
import { renderMarkdownHtml } from "../debug/markdown";
import { NatsEventTracker } from "../debug/nats-tracker";
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
import type { AiDebugSummary, AppKnowledge, KnowledgeOptions, SystemStats } from "../debug/types";
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
   * Optional data sources for the extra debugbar panels:
   *  - `jobs` — a durable JobStore; shows queued/running/completed/failed
   *    job counts + recent jobs.
   *  - `routes` — a function returning the current route list (method, path,
   *    file) for the Routes panel; defaults to the router/manifest map the
   *    KT page already builds.
   */
  data?: {
    jobs?: { list(): Promise<Array<{ name: string; status: string; runAt: number }>> };
    routes?: () => Promise<Array<{ method: string; path: string; file: string }>>;
  };
  /**
   * NATS event tracking for the Events panel:
   *  - `url` — NATS server (`nats://host:4222`); defaults to `$NATS_URL`.
   *    Without a URL the panel shows "not configured".
   *  - `subjects` — subjects to subscribe to for inbound tracking
   *    (default `["events.>"]`).
   *  - `maxEvents` — retained events in the ring buffer (default 500).
   *  - `connect` — connect at startup (default true; failures are recorded,
   *    never thrown).
   */
  nats?: {
    url?: string;
    subjects?: string[];
    maxEvents?: number;
    connect?: boolean;
  };
  /**
   * Extra frontend-client package probes for the Clients panel — directories
   * containing `package.json`, the `package.json` path itself, or an
   * `sdk.json` metadata file. Defaults probe `dist/sdk` + `.ignex/sdk` and
   * anything `sdkPaths` points at. Each probed package is shown with its
   * local version + matching git tags (the `ignex sdk --push` release signal).
   */
  clientPaths?: string[];
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
  readonly clientPaths: string[];
  readonly plugins: string[];
  readonly active: Map<string, Trace>;
  /** NATS event tracker (null when NATS is not configured). */
  readonly nats: NatsEventTracker | null;
  /** Published SDK + frontend-client registry (git tags + local probes). */
  readonly clients: ClientRegistry;
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
    clientPaths: options.clientPaths ?? [],
    plugins: ["debugbar", ...(options.plugins ?? [])],
    active: new Map(),
    // Auto-enabled by $NATS_URL even without an explicit `nats` option — the
    // tracker itself reads the env default when options.nats is absent.
    nats:
      options.nats !== undefined || process.env.NATS_URL
        ? new NatsEventTracker(options.nats)
        : null,
    clients: new ClientRegistry(),
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
    if (rest === "/app.css") {
      return new Response(DEBUGBAR_DASHBOARD_CSS, {
        status: 200,
        headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (rest.startsWith("/api/")) {
      if (!authorized(state, ctx)) return json({ error: "forbidden" }, 403);
      return serveApi(rest.slice(5), ctx);
    }
    return notFound();
  };

  const ktData = async (): Promise<{
    markdown: string;
    html: string | null;
    knowledge: AppKnowledge;
  }> => {
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
    const markdown = formatKnowledgeMarkdown(knowledge);
    // Server-rendered sanitized HTML (Bun.markdown) preferred by the dashboard;
    // `markdown` is kept for clients without the builtin (and tests).
    return { markdown, html: renderMarkdownHtml(markdown), knowledge };
  };

  /** GET {path}/api/jobs — durable job store panel (optional data.jobs). */
  const serveJobs = async (): Promise<Response> => {
    if (!options.data?.jobs) return json({ enabled: false });
    try {
      const jobs = await options.data.jobs.list();
      return json({
        enabled: true,
        total: jobs.length,
        byStatus: jobs.reduce<Record<string, number>>((acc, j) => {
          acc[j.status] = (acc[j.status] ?? 0) + 1;
          return acc;
        }, {}),
        recent: jobs.slice(-20).reverse(),
      });
    } catch (err) {
      return json({ enabled: true, error: err instanceof Error ? err.message : String(err) });
    }
  };

  /** GET {path}/api/routes — route inventory panel. */
  const serveRoutes = async (): Promise<Response> => {
    const provider = options.data?.routes;
    if (!provider) {
      const { knowledge } = await ktData();
      return json({ enabled: true, routes: knowledge.routes });
    }
    try {
      return json({ enabled: true, routes: await provider() });
    } catch (err) {
      return json({ enabled: true, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const serveMeta = (): Response =>
    json({
      serviceName: state.serviceName,
      version: state.version,
      environment: process.env.NODE_ENV ?? "development",
      debugMode: state.enabled,
      path: state.path,
      nativeAvailable: isNativeAvailable(),
      bufferSize: state.store.size,
    });

  const serveRequests = (ctx: IgnexContext): Response => {
    const url = ctx.url;
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const q = url.searchParams.get("q") ?? undefined;
    const method = url.searchParams.get("method") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const errorOnly = url.searchParams.get("error") === "1";
    const options: {
      errorOnly?: boolean;
      q?: string;
      method?: string;
      status?: string;
      limit?: number;
    } = { errorOnly, limit: Number.isFinite(limit) ? limit : 100 };
    if (q !== undefined) options.q = q;
    if (method !== undefined) options.method = method;
    if (status !== undefined) options.status = status;
    return json(state.store.summaries(options));
  };

  const serveSystem = (): Response => {
    const p = state.store.percentiles();
    const stats: SystemStats = state.profiler.stats({
      requests: state.store.size,
      errors: state.store.errorCount,
      avgMs: p.avgMs,
      p95Ms: p.p95Ms,
    });
    return json(stats);
  };

  const serveKt = async (): Promise<Response> => json(await ktData());

  /** Probe paths for the Clients panel: sdkPaths + clientPaths, deduped. */
  const clientProbePaths = (): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of [...state.sdkPaths, ...state.clientPaths]) {
      if (p === "" || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    return out;
  };

  /** GET {path}/api/sdks — SDK metadata enriched with git-tag state. */
  const serveSdks = async (): Promise<Response> => {
    const { knowledge } = await ktData();
    const sdk = knowledge.sdk;
    if (sdk === null) return json({ sdk: null });
    // Best-effort tag enrichment: find the matching package in the client
    // registry (same name) and copy its tags + published state.
    const published = state.clients.list(clientProbePaths()).find((c) => c.name === sdk.name);
    if (published === undefined) return json({ sdk });
    return json({
      sdk: {
        ...sdk,
        gitTags: [...published.gitTags],
        published: published.published,
      },
    });
  };

  /** GET {path}/api/clients — published SDK + frontend clients (git + local). */
  const serveClients = (ctx: IgnexContext): Response => {
    if (ctx.url.searchParams.get("refresh") === "1") state.clients.refresh();
    const clients = state.clients.list(clientProbePaths());
    return json({
      enabled: true,
      count: clients.length,
      gitError: state.clients.error,
      clients: clients.map((c: PublishedClient) => ({
        kind: c.kind,
        platform: c.platform,
        name: c.name,
        version: c.version,
        location: c.location,
        files: c.files,
        gitTags: c.gitTags,
        latestTag: c.latestTag,
        published: c.published,
      })),
    });
  };

  /** GET {path}/api/events — NATS event stats + recent events. */
  const serveEvents = (ctx: IgnexContext): Response => {
    const tracker = state.nats;
    if (tracker === null) {
      return json({
        enabled: false,
        hint: "NATS not configured — set NATS_URL or debugbar({ nats: { url } }).",
        stats: null,
        recent: [],
      });
    }
    const url = ctx.url;
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const subject = url.searchParams.get("subject") ?? undefined;
    const direction = url.searchParams.get("direction") ?? undefined;
    const listOptions: { limit?: number; subject?: string; direction?: "in" | "out" } = {
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 100,
    };
    if (subject !== undefined) listOptions.subject = subject;
    if (direction === "in" || direction === "out") listOptions.direction = direction;
    const recent = tracker.list(listOptions);
    return json({ enabled: true, stats: tracker.stats(), recent });
  };

  /** POST {path}/api/events/publish — publish a probe event through NATS. */
  const serveEventPublish = async (ctx: IgnexContext): Promise<Response> => {
    const tracker = state.nats;
    if (tracker === null) {
      return json({ ok: false, error: "NATS not configured (no NATS_URL)" }, 400);
    }
    let body: { subject?: unknown; payload?: unknown };
    try {
      body = (await ctx.req.json()) as { subject?: unknown; payload?: unknown };
    } catch {
      return json({ ok: false, error: "Invalid JSON body — expected { subject, payload }" }, 400);
    }
    const subject =
      typeof body.subject === "string" && body.subject.trim() !== "" ? body.subject.trim() : null;
    if (subject === null) {
      return json({ ok: false, error: "Missing subject" }, 400);
    }
    const result = tracker.publish(subject, body.payload ?? {});
    return json({
      ok: result.ok,
      subject,
      error: result.error,
      note: result.ok
        ? "published — check the Events panel for the record"
        : "publish failed — check the NATS connection status",
    });
  };

  /** POST {path}/api/events/clear — drop the retained event buffer. */
  const serveEventsClear = (): Response => {
    state.nats?.clear();
    return json({ ok: true, cleared: true });
  };

  /** GET {path}/api/ai/summary — compact AI-facing debug snapshot. */
  const serveAiSummary = async (): Promise<Response> => {
    const p = state.store.percentiles();
    const traces = state.store.list();
    const recentErrors = traces
      .filter((t) => t.error !== null)
      .slice(0, 8)
      .map((t) => ({
        id: t.id,
        ts: t.ts,
        method: t.method,
        path: t.path,
        status: t.status,
        error: t.error as string,
      }));
    const slowest = [...traces]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5)
      .map((t) => ({
        id: t.id,
        ts: t.ts,
        method: t.method,
        path: t.path,
        durationMs: t.durationMs,
        status: t.status,
      }));
    const eventStats = state.nats?.stats() ?? null;
    const clients = state.clients.list(clientProbePaths()).map((c) => ({
      kind: c.kind,
      platform: c.platform,
      name: c.name,
      version: c.version,
      published: c.published,
      gitTags: c.gitTags.slice(0, 5),
    }));
    const { knowledge } = await ktData();
    const summary: AiDebugSummary = {
      service: state.serviceName,
      version: state.version,
      environment: process.env.NODE_ENV ?? "development",
      uptimeSec: Math.round(process.uptime()),
      traces: {
        total: state.store.size,
        errors: state.store.errorCount,
        avgDurationMs: p.avgMs,
        p95DurationMs: p.p95Ms,
        recentErrors,
        slowest,
      },
      events: {
        enabled: eventStats?.enabled ?? false,
        connected: eventStats?.connected ?? false,
        total: eventStats?.total ?? 0,
        errors: eventStats?.errors ?? 0,
        bySubject: eventStats?.bySubject ?? {},
      },
      clients,
      routes: knowledge.routes.length,
    };
    return json(summary);
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a linear API-path dispatcher — one branch per endpoint
  const serveApi = async (apiPath: string, ctx: IgnexContext): Promise<Response> => {
    if (apiPath === "meta") return serveMeta();
    if (apiPath === "requests") return serveRequests(ctx);
    if (apiPath === "requests/clear") {
      state.store.clear();
      return json({ ok: true, cleared: true });
    }
    const replayMatch = apiPath.match(/^requests\/([^/]+)\/replay$/);
    if (replayMatch?.[1] !== undefined && ctx.method === "POST") {
      return replayRequest(state.store, decodeURIComponent(replayMatch[1]), ctx, options.dispatch);
    }
    const idMatch = apiPath.match(/^requests\/([^/]+)$/);
    if (idMatch?.[1] !== undefined) {
      const trace = state.store.get(decodeURIComponent(idMatch[1]));
      return trace ? json(redactRequestTrace(trace)) : json({ error: "not_found" }, 404);
    }
    if (apiPath === "system") return serveSystem();
    if (apiPath === "kt") return serveKt();
    if (apiPath === "sdks") return serveSdks();
    if (apiPath === "clients") return serveClients(ctx);
    if (apiPath === "ai/summary") return serveAiSummary();
    if (apiPath === "events") return serveEvents(ctx);
    if (apiPath === "events/clear") {
      if (ctx.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      return serveEventsClear();
    }
    if (apiPath === "events/publish") {
      if (ctx.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      return serveEventPublish(ctx);
    }
    if (apiPath === "jobs") return serveJobs();
    if (apiPath === "routes") return serveRoutes();
    return notFound();
  };
  // ── interpreted mode: register the dashboard routes on the router ───────

  const registerRoutes = (router: IgnexRouter): void => {
    state.router = router;
    router.get(path, () => new Response(null, { status: 302, headers: { location: `${path}/` } }));
    router.get(`${path}/`, () => html(DEBUGBAR_DASHBOARD_HTML.replaceAll("__BASE__", path)));
    router.get(`${path}/app.js`, () => html(DEBUGBAR_DASHBOARD_JS));
    router.get(
      `${path}/app.css`,
      () =>
        new Response(DEBUGBAR_DASHBOARD_CSS, {
          status: 200,
          headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" },
        }),
    );
    router.get(`${path}/api/meta`, (ctx) => serveApi("meta", ctx));
    router.get(`${path}/api/requests`, (ctx) => serveApi("requests", ctx));
    router.get(`${path}/api/requests/clear`, (ctx) => serveApi("requests/clear", ctx));
    router.get(`${path}/api/system`, (ctx) => serveApi("system", ctx));
    router.get(`${path}/api/kt`, async (ctx) => serveApi("kt", ctx));
    router.get(`${path}/api/sdks`, async (ctx) => serveApi("sdks", ctx));
    router.get(`${path}/api/clients`, async (ctx) => serveApi("clients", ctx));
    router.get(`${path}/api/ai/summary`, async (ctx) => serveApi("ai/summary", ctx));
    router.get(`${path}/api/events`, async (ctx) => serveApi("events", ctx));
    router.post(`${path}/api/events/publish`, async (ctx) => serveApi("events/publish", ctx));
    router.post(`${path}/api/events/clear`, async (ctx) => serveApi("events/clear", ctx));
    router.get(`${path}/api/jobs`, async (ctx) => serveApi("jobs", ctx));
    router.get(`${path}/api/routes`, async (ctx) => serveApi("routes", ctx));
    router.get(`${path}/api/requests/:id`, (ctx) => {
      const id = ctx.params.id;
      if (id === undefined) return json({ error: "not_found" }, 404);
      const trace = state.store.get(id);
      return trace ? json(redactRequestTrace(trace)) : json({ error: "not_found" }, 404);
    });
    router.post(`${path}/api/requests/:id/replay`, (ctx) => {
      const id = ctx.params.id;
      if (id === undefined) return json({ error: "not_found" }, 404);
      return replayRequest(state.store, id, ctx, options.dispatch);
    });
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
        `[ignex] debugbar: ${state.bootUrl} — request waterfall, DB timing, errors + replay, system profile, NATS events, published clients, KT docs (debug mode)`,
      );
      state.profiler.start();
      // NATS event tracking (best effort — a missing/broken server records
      // the failure in the Events panel instead of crashing boot).
      state.nats?.start();
      const natsStatus = state.nats?.stats();
      if (natsStatus?.enabled === true) {
        console.log(
          `[ignex] debugbar: NATS events ${natsStatus.connected ? "connected" : `not connected (${natsStatus.status})`} at ${natsStatus.url} — subjects: ${natsStatus.subjects.join(", ")}`,
        );
      }
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
      state.nats?.stop();
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
