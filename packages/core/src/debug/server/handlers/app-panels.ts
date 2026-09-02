/**
 * @fileoverview App-panel handlers — KT knowledge, SDK/clients registries,
 * jobs, routes, NATS/nova events and the AI summary. Same contract as the
 * data panels: factories over {@link HandlerDeps} returning ctx→Response.
 */

import type { IgnexContext } from "../../../http/context";
import type { IgnexRouter } from "../../../http/router";
import type { NovaEventTrace, NovaEventTraceRow } from "../../../plugins/nova";
import { buildAppKnowledge, formatKnowledgeMarkdown } from "../../kt";
import { analyzeSamples } from "../../leaks";
import { renderMarkdownHtml } from "../../markdown";
import type { NatsEventSummary, NatsEventTracker } from "../../nats-tracker";
import { json } from "../../respond";
import { buildAppState } from "../../state";
import type {
  AiDebugSummary,
  AppKnowledge,
  DebugEventRow,
  DebugEventSourceInfo,
  DebugEventsPayload,
  KnowledgeOptions,
  RequestTrace,
} from "../../types";
import type { HandlerDeps, NovaProbeHandle } from "../types";
import { clampLimit, numberParam } from "./data-panels";

/* ── unified Events panel (NATS + nova/WS realtime) ─────────────────────── */

/** Shown when neither source is wired. */
const EVENTS_OFF_HINT =
  "No event source wired. NATS: set NATS_URL or debugbar({ nats: { url } }). " +
  "Realtime (WS): register novaPlugin and pass debugbar({ data: { nova: () => nova.server } }).";

/** Map one NATS tracker row into the unified event-buffer row. */
const toNatsRow = (e: NatsEventSummary): DebugEventRow => ({
  id: e.id,
  ts: e.ts,
  source: "nats",
  direction: e.direction,
  kind: e.direction === "out" ? "publish" : "message",
  name: e.subject,
  payload: e.payload,
  size: e.size,
  error: e.error,
});

/** Map one nova trace row into the unified event-buffer row. */
const toNovaRow = (r: NovaEventTraceRow): DebugEventRow => ({
  id: `nv-${r.seq}`,
  ts: r.ts,
  source: "nova",
  direction: r.direction.startsWith("in.") ? "in" : "out",
  kind: r.direction.includes(".") ? r.direction.slice(r.direction.indexOf(".") + 1) : r.direction,
  name: r.name,
  ...(r.key !== undefined && r.key !== "" ? { key: r.key } : {}),
  payload: r.payload ?? "",
  size: r.bytes,
  error: null,
});

/** Per-source summary block for NATS. */
const natsSourceInfo = (tracker: NatsEventTracker): DebugEventSourceInfo => {
  const st = tracker.stats();
  return {
    present: st.enabled,
    label: "NATS bus",
    connected: st.connected,
    status: st.status,
    // NATS keeps one counter: retained rows (no lifetime-writes total).
    size: st.total,
    total: st.total,
    in: st.in,
    out: st.out,
    errors: st.errors,
    bytes: st.bytes,
    byName: st.bySubject,
  };
};

/** Read + shape the nova trace ring into the per-source summary block. */
const novaSourceInfo = (trace: NovaEventTrace | null): DebugEventSourceInfo | null => {
  if (trace === null) return null;
  const st = trace.stats;
  return {
    present: trace.enabled,
    label: "Nova realtime (WS)",
    size: st.size,
    total: st.total,
    in: st.inCount,
    out: st.outCount,
    errors: 0,
    bytes: st.bytes,
    byName: st.byName,
    // Payload previews only exist when the ring captures them — signal the
    // UI to offer the novaPlugin trace option when they're absent.
    captures: trace.recent.some((r) => r.payload !== undefined),
  };
};

/** Resolve + read the wired nova trace (null when absent/broken — never throws). */
const readNovaTrace = (handle: NovaProbeHandle, limit = 100): NovaEventTrace | null => {
  try {
    if (typeof handle.getEventTrace !== "function") return null;
    const trace = handle.getEventTrace({ limit }) as unknown as NovaEventTrace;
    if (typeof trace !== "object" || trace === null) return null;
    return trace;
  } catch {
    return null;
  }
};

/** Assemble the KT payload (knowledge + markdown + sanitized HTML). */
export const createKtData =
  (deps: HandlerDeps) =>
  async (): Promise<{
    markdown: string;
    html: string | null;
    knowledge: AppKnowledge;
  }> => {
    const options: KnowledgeOptions & { router?: IgnexRouter; traces?: readonly RequestTrace[] } = {
      serviceName: deps.state.serviceName,
      version: deps.state.version,
      manifestPaths: deps.state.manifestPaths,
      sdkPaths: deps.state.sdkPaths,
      docsPaths: deps.state.docsPaths,
      projectRoot: deps.state.projectRoot,
      plugins: deps.state.plugins,
      // DB activity = what the retained requests actually did.
      traces: deps.state.store.list(),
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
    if (deps.state.router) options.router = deps.state.router;
    const knowledge = await buildAppKnowledge(options);
    const markdown = formatKnowledgeMarkdown(knowledge);
    return { markdown, html: renderMarkdownHtml(markdown), knowledge };
  };

/** `GET /api/state` — application/process snapshot. */
export const createStateHandler =
  (deps: HandlerDeps, ktData: () => Promise<{ knowledge: AppKnowledge }>) =>
  async (): Promise<Response> => {
    const { knowledge } = await ktData();
    return json(
      buildAppState({
        serviceName: deps.state.serviceName,
        version: deps.state.version,
        debugMode: deps.state.enabled,
        routeCount: knowledge.routes.length,
        plugins: knowledge.plugins.map((p) => p.name),
        tracesRetained: deps.state.store.size,
        logsRetained: deps.state.logs.size,
        activeRequests: deps.state.active.size,
        features: {
          logs: true,
          metrics: true,
          persist: deps.state.sink?.status().available === true,
        },
      }),
    );
  };

/** Probe paths for the Clients panel: sdkPaths + clientPaths, deduped. */
export const clientProbePaths = (deps: HandlerDeps): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...deps.state.sdkPaths, ...deps.state.clientPaths]) {
    if (p === "" || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
};

/** `GET /api/sdks` — SDK metadata enriched with git-tag state. */
export const createSdksHandler =
  (deps: HandlerDeps, ktData: () => Promise<{ knowledge: AppKnowledge }>) =>
  async (): Promise<Response> => {
    const { knowledge } = await ktData();
    const sdk = knowledge.sdk;
    if (sdk === null) return json({ sdk: null });
    const published = deps.state.clients
      .list(clientProbePaths(deps))
      .find((c) => c.name === sdk.name);
    if (published === undefined) return json({ sdk });
    return json({
      sdk: { ...sdk, gitTags: [...published.gitTags], published: published.published },
    });
  };

/** `GET /api/clients` — published SDK + frontend clients (git + local). */
export const createClientsHandler =
  (deps: HandlerDeps) =>
  (ctx: IgnexContext): Response => {
    if (ctx.url.searchParams.get("refresh") === "1") deps.state.clients.refresh();
    const clients = deps.state.clients.list(clientProbePaths(deps));
    return json({
      enabled: true,
      count: clients.length,
      gitError: deps.state.clients.error,
      clients: clients.map((c) => ({
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

/** `GET /api/jobs` — durable job store panel (optional data.jobs). */
export const createJobsHandler = (deps: HandlerDeps) => async (): Promise<Response> => {
  if (!deps.data?.jobs) return json({ enabled: false });
  try {
    const jobs = await deps.data.jobs.list();
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

/** `GET /api/routes` — route inventory (provider or KT-derived). */
export const createRoutesHandler =
  (deps: HandlerDeps, ktData: () => Promise<{ knowledge: AppKnowledge }>) =>
  async (): Promise<Response> => {
    const provider = deps.data?.routes;
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

/** Resolve the wired nova handle (null when absent/dead — never throws). */
export const novaHandle = (deps: HandlerDeps): NovaProbeHandle | null => {
  try {
    return deps.data?.nova?.() ?? null;
  } catch {
    return null;
  }
};

/** `GET /api/events` — unified event buffer (NATS + nova/WS realtime). */
export const createEventsHandler =
  (deps: HandlerDeps) =>
  (ctx: IgnexContext): Response => {
    const limit = clampLimit(numberParam(ctx, "limit"), 100, 500);
    const tracker = deps.state.nats;
    const handle = novaHandle(deps);
    const trace = handle === null ? null : readNovaTrace(handle, limit);
    const nats = tracker === null ? null : natsSourceInfo(tracker);
    const nova = novaSourceInfo(trace);

    if (nats === null && nova === null) {
      return json({
        enabled: false,
        hint: EVENTS_OFF_HINT,
        sources: { nats: null, nova: null },
        recent: [],
      } satisfies DebugEventsPayload);
    }

    const dirRaw = ctx.url.searchParams.get("direction");
    const dirFilter: "in" | "out" | undefined =
      dirRaw === "in" || dirRaw === "out" ? dirRaw : undefined;
    // One free-text needle sweeps both sources (nats subject OR nova event name).
    const needle = (
      ctx.url.searchParams.get("subject") ??
      ctx.url.searchParams.get("name") ??
      ctx.url.searchParams.get("q") ??
      ""
    )
      .trim()
      .toLowerCase();

    const rows: DebugEventRow[] = [];
    if (tracker !== null) for (const e of tracker.list({ limit })) rows.push(toNatsRow(e));
    if (trace !== null) for (const r of trace.recent.slice(0, limit)) rows.push(toNovaRow(r));

    const recent = rows
      .filter((r) => dirFilter === undefined || r.direction === dirFilter)
      .filter(
        (r) =>
          needle === "" ||
          r.name.toLowerCase().includes(needle) ||
          (r.key ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);

    return json({
      enabled: true,
      sources: { nats, nova },
      recent,
    } satisfies DebugEventsPayload);
  };

/** `POST /api/events/publish` — publish a probe event through NATS. */
export const createEventPublishHandler =
  (deps: HandlerDeps) =>
  async (ctx: IgnexContext): Promise<Response> => {
    const tracker = deps.state.nats;
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
    if (subject === null) return json({ ok: false, error: "Missing subject" }, 400);
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

/** `POST /api/events/clear` — drop the retained event buffer (NATS + nova). */
export const createEventsClearHandler = (deps: HandlerDeps) => (): Response => {
  deps.state.nats?.clear();
  const handle = novaHandle(deps);
  if (handle !== null && typeof handle.clearEventTrace === "function") {
    try {
      handle.clearEventTrace();
    } catch {
      /* a broken probe must not fail the clear */
    }
  }
  return json({ ok: true, cleared: true });
};

/** `GET /api/nova/events` — FlatBuffer transport trace. */
export const createNovaEventsHandler =
  (deps: HandlerDeps) =>
  (ctx: IgnexContext): Response => {
    const handle = novaHandle(deps);
    if (!handle || typeof handle.getEventTrace !== "function") {
      return json({
        enabled: false,
        hint: "nova not wired — pass data.nova: () => novaPlugin.server to debugbar()",
        stats: null,
        recent: [],
      });
    }
    const direction = ctx.url.searchParams.get("direction") ?? undefined;
    const name = ctx.url.searchParams.get("name") ?? undefined;
    const doc = handle.getEventTrace({
      limit: clampLimit(numberParam(ctx, "limit"), 100, 500),
      ...(direction !== undefined ? { direction } : {}),
      ...(name !== undefined ? { name } : {}),
    }) as Record<string, unknown>;
    return json(doc);
  };

/** `POST /api/nova/events/clear` — drop the nova trace ring rows. */
export const createNovaClearHandler = (deps: HandlerDeps) => (): Response => {
  const handle = novaHandle(deps);
  if (!handle || typeof handle.clearEventTrace !== "function") {
    return json({ ok: false, error: "nova not wired" }, 400);
  }
  handle.clearEventTrace();
  return json({ ok: true, cleared: true });
};

/** Target kinds the emit composer accepts, mapped to events-hub methods. */
const NOVA_EMIT_METHODS = {
  user: "emitToUser",
  group: "emitToGroup",
  topic: "emitToTopic",
  client: "emitToClient",
} as const;

/** A targeted events-hub emit: (recipient key, event name, payload). */
type NovaEmitFn = (recipient: string, name: string, payload: unknown) => void;

/**
 * Parse the optional `type:key` emit target. Returns the parsed target (a
 * `null` type = broadcast) or a `{ error }` result.
 */
const parseNovaEmitTarget = (
  raw: string | null,
): { error: string } | { type: keyof typeof NOVA_EMIT_METHODS | null; key: string | null } => {
  if (raw === null) return { type: null, key: null };
  const sep = raw.indexOf(":");
  const head = sep === -1 ? raw : raw.slice(0, sep);
  const rest = sep === -1 ? null : raw.slice(sep + 1);
  if (!(head in NOVA_EMIT_METHODS)) {
    return {
      error: `unknown target "${head}" — use user|group|topic|client (e.g. user:u-42) or leave empty to broadcast`,
    };
  }
  if (rest === null || rest === "") {
    return { error: `target "${head}" needs a key, e.g. "${head}:value"` };
  }
  return { type: head as keyof typeof NOVA_EMIT_METHODS, key: rest };
};

/**
 * Execute one manual emit against the wired nova handle. Never throws: hub
 * rejections (e.g. an unregistered event name) become the error result.
 */
const executeNovaEmit = (
  handle: NovaProbeHandle,
  name: string,
  payload: unknown,
  type: keyof typeof NOVA_EMIT_METHODS | null,
  key: string | null,
): { ok: true; note: string } | { ok: false; error: string } => {
  const events = handle.events;
  try {
    if (type !== null && key !== null) {
      const method = NOVA_EMIT_METHODS[type];
      const fn = events?.[method] as NovaEmitFn | undefined;
      if (typeof fn !== "function") {
        return {
          ok: false,
          error: `nova events hub exposes no ${method} — is the events layer enabled? (broadcast emit still works)`,
        };
      }
      fn(key, name, payload);
      return { ok: true, note: `emitted ${name} → ${type} ${key}` };
    }
    if (typeof events?.emit === "function") {
      events.emit(name, payload);
      return { ok: true, note: `emitted ${name} (broadcast)` };
    }
    if (typeof handle.publish === "function") {
      handle.publish(name, payload);
      return { ok: true, note: `published ${name} (transport — no events hub)` };
    }
    return {
      ok: false,
      error: "nova handle exposes no emit/publish surface — check the wired novaPlugin",
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * `POST /api/nova/events/emit` — fire a realtime event MANUALLY for testing.
 *
 * Body `{ name, payload?, target? }` where `target` is `""`/absent for a
 * broadcast emit, or `"user:u-42"` / `"group:premium"` / `"topic:room"` /
 * `"client:c-1"` to target one recipient. Routes through the nova events hub
 * (so server-side consumers AND subscribed clients receive it) and falls back
 * to the transport `publish` when the events layer is absent. Everything here
 * is dev-only — eliminated from production-shaped builds with the debugbar.
 */
export const createNovaEmitHandler =
  (deps: HandlerDeps) =>
  async (ctx: IgnexContext): Promise<Response> => {
    const handle = novaHandle(deps);
    if (handle === null) {
      return json(
        {
          ok: false,
          error: "nova not wired — pass data.nova: () => novaPlugin.server to debugbar()",
        },
        400,
      );
    }
    let body: { name?: unknown; payload?: unknown; target?: unknown };
    try {
      body = (await ctx.req.json()) as { name?: unknown; payload?: unknown; target?: unknown };
    } catch {
      return json(
        { ok: false, error: "Invalid JSON body — expected { name, payload?, target? }" },
        400,
      );
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name === "") return json({ ok: false, error: "Missing event name" }, 400);
    const rawTarget =
      typeof body.target === "string" && body.target.trim() !== "" ? body.target.trim() : null;
    const target = parseNovaEmitTarget(rawTarget);
    if ("error" in target) return json({ ok: false, error: target.error }, 400);
    const result = executeNovaEmit(handle, name, body.payload ?? {}, target.type, target.key);
    if (!result.ok) return json({ ok: false, error: result.error }, 400);
    return json({ ok: true, name, note: result.note });
  };

/** `GET /api/ai/summary` — compact AI-facing debug snapshot. */
export const createAiSummaryHandler =
  (deps: HandlerDeps, ktData: () => Promise<{ knowledge: AppKnowledge }>) =>
  async (): Promise<Response> => {
    const p = deps.state.store.percentiles();
    const traces = deps.state.store.list();
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
    const eventStats = deps.state.nats?.stats() ?? null;

    let nova: AiDebugSummary["nova"];
    const handle = novaHandle(deps);
    if (handle && typeof handle.getEventTrace === "function") {
      try {
        const doc = handle.getEventTrace({
          limit: 8,
        }) as import("../../../plugins/nova").NovaEventTrace;
        if (doc !== undefined && doc !== null) {
          const st = doc.stats;
          nova = {
            enabled: doc.enabled,
            size: st.size,
            total: st.total,
            inCount: st.inCount,
            outCount: st.outCount,
            byName: st.byName,
            recent: doc.recent.map((r) => ({
              ts: r.ts,
              direction: r.direction,
              name: r.name,
              ...(r.target !== undefined ? { target: r.target } : {}),
              ...(r.key !== undefined ? { key: r.key } : {}),
              bytes: r.bytes,
            })),
          };
        }
      } catch {
        /* a broken probe must not break the summary */
      }
    }

    const clients = deps.state.clients.list(clientProbePaths(deps)).map((c) => ({
      kind: c.kind,
      platform: c.platform,
      name: c.name,
      version: c.version,
      published: c.published,
      gitTags: c.gitTags.slice(0, 5),
    }));
    const { knowledge } = await ktData();
    const diagnostics = analyzeSamples(deps.state.profiler.stats().samples);
    const badLogs = deps.state.logs.list({ minLevel: "warn", limit: 5 });
    const sinkStatus = deps.state.sink?.status();
    const summary: AiDebugSummary = {
      service: deps.state.serviceName,
      version: deps.state.version,
      environment: process.env.NODE_ENV ?? "development",
      uptimeSec: Math.round(process.uptime()),
      traces: {
        total: deps.state.store.size,
        errors: deps.state.store.errorCount,
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
      ...(nova !== undefined ? { nova } : {}),
      observatory: {
        verdict: diagnostics.verdict,
        findings: diagnostics.findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          title: f.title,
        })),
        heapMiBPerMin: diagnostics.trend.heapMiBPerMin,
        logErrors: deps.state.logs.stats().error,
        recentWarnings: badLogs.map((l) => ({
          ts: l.ts,
          level: l.level as string,
          message: l.message.slice(0, 200),
          ...(l.traceId !== null ? { traceId: l.traceId } : {}),
        })),
        persist: {
          enabled: sinkStatus?.available ?? false,
          path: sinkStatus?.path ?? null,
        },
      },
      routes: knowledge.routes.length,
    };
    return json(summary);
  };
