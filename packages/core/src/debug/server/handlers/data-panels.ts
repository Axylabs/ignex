/**
 * @fileoverview Data-panel handlers — requests (list/detail/replay/clear),
 * history, logs, metrics, system profile and diagnostics. Each factory
 * receives the shared {@link HandlerDeps} and returns pure ctx→Response
 * functions; the endpoint table composes them.
 */

import { isNativeAvailable } from "@ignex/native";
import type { IgnexContext } from "../../../http/context";
import { buildCurl } from "../../curl";
import { analyzeSamples, forceGc } from "../../leaks";
import { replayRequest } from "../../replay";
import { json } from "../../respond";
import { redactRequestTrace } from "../../tracer";
import type { LogLevel, RequestTrace } from "../../types";
import type { RouteFileIndex } from "../route-index";
import type { HandlerDeps } from "../types";

/** Integer query param reader (`undefined` when absent/non-numeric). */
export const numberParam = (ctx: IgnexContext, name: string): number | undefined => {
  const raw = ctx.url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

/** Clamp a limit param into a sane range. */
export const clampLimit = (value: number | undefined, fallback: number, max = 1000): number =>
  value === undefined ? fallback : Math.min(Math.max(Math.trunc(value), 1), max);

/** `GET /api/meta` — boot info + feature flags. */
export const createMetaHandler = (deps: HandlerDeps) => (): Response =>
  json({
    serviceName: deps.state.serviceName,
    version: deps.state.version,
    environment: process.env.NODE_ENV ?? "development",
    debugMode: deps.state.enabled,
    path: deps.state.path,
    nativeAvailable: isNativeAvailable(),
    bufferSize: deps.state.store.size,
    features: {
      logs: true,
      metrics: true,
      diagnostics: true,
      history: deps.state.sink?.status().available ?? false,
    },
  });

/** `GET /api/requests` — live trace summaries with filters (limit clamped). */
export const createRequestsHandler =
  (deps: HandlerDeps) =>
  (ctx: IgnexContext): Response => {
    const url = ctx.url;
    const q = url.searchParams.get("q");
    const method = url.searchParams.get("method");
    const status = url.searchParams.get("status");
    const since = numberParam(ctx, "since");
    const until = numberParam(ctx, "until");
    const minDurationMs = numberParam(ctx, "minMs");
    return json(
      deps.state.store.summaries({
        errorOnly: url.searchParams.get("error") === "1",
        ...(q !== null && q !== "" ? { q } : {}),
        ...(method !== null && method !== "" ? { method } : {}),
        ...(status !== null && status !== "" ? { status } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(minDurationMs !== undefined ? { minDurationMs } : {}),
        limit: clampLimit(numberParam(ctx, "limit"), 100),
      }),
    );
  };

/** `GET /api/requests/clear` — drop the live ring (POST semantics enforced upstream). */
export const createRequestsClearHandler = (deps: HandlerDeps) => (): Response => {
  deps.state.store.clear();
  return json({ ok: true, cleared: true });
};

/** Factory for the request-detail handler (needs the lazy route-file index). */
export const createRequestDetailHandler =
  (deps: HandlerDeps, routeIndex: RouteFileIndex) =>
  async (id: string): Promise<Response> => {
    const trace = deps.state.store.get(decodeURIComponent(id));
    if (!trace) return json({ error: "not_found" }, 404);
    // curl is built from ALREADY-redacted headers; sourceFile points at the
    // original route module ("where in my code").
    const redacted = redact(trace);
    return json({
      ...redacted,
      curl: buildCurl(redacted),
      sourceFile:
        (await routeIndex.lookup(`${trace.method} ${trace.route}`)) ??
        (await routeIndex.lookup(`${trace.method} ${trace.path}`)),
    });
  };

/** `POST /api/requests/:id/replay` — re-issue a stored request. */
export const createReplayHandler =
  (deps: HandlerDeps) =>
  (ctx: IgnexContext, id: string): Promise<Response> =>
    replayRequest(deps.state.store, decodeURIComponent(id), ctx, deps.dispatch);

/** `GET /api/system` — profiler stats + sample ring. */
export const createSystemHandler = (deps: HandlerDeps) => (): Response => {
  const p = deps.state.store.percentiles();
  return json(
    deps.state.profiler.stats({
      requests: deps.state.store.size,
      errors: deps.state.store.errorCount,
      avgMs: p.avgMs,
      p95Ms: p.p95Ms,
    }),
  );
};

/** `GET /api/history` — persisted trace summaries (cross-restart). */
export const createHistoryHandler =
  (deps: HandlerDeps) =>
  (ctx: IgnexContext): Response => {
    if (!deps.state.sink) return json({ enabled: false, rows: [] });
    const rows = deps.state.sink.queryTraces({
      since: numberParam(ctx, "since"),
      until: numberParam(ctx, "until"),
      q: ctx.url.searchParams.get("q") ?? undefined,
      method: ctx.url.searchParams.get("method") ?? undefined,
      ...(ctx.url.searchParams.get("status")
        ? { status: ctx.url.searchParams.get("status") as string }
        : {}),
      errorsOnly: ctx.url.searchParams.get("error") === "1",
      minDurationMs: numberParam(ctx, "minMs"),
      limit: clampLimit(numberParam(ctx, "limit"), 100),
    });
    return json({ enabled: true, rows });
  };

/** `GET /api/history/:id` — one persisted trace, fully reconstructed. */
export const createHistoryDetailHandler =
  (deps: HandlerDeps) =>
  (id: string): Response => {
    const trace = deps.state.sink?.getTrace(id);
    return trace ? json(trace) : json({ error: "not_found" }, 404);
  };

/** `GET /api/logs` — structured log records (+ persisted mode, clamped). */
export const createLogsHandler =
  (deps: HandlerDeps) =>
  (ctx: IgnexContext): Response => {
    const persisted = ctx.url.searchParams.get("persisted") === "1";
    const level = ctx.url.searchParams.get("level");
    const query = {
      minLevel: level !== null && level !== "" ? (level as LogLevel) : undefined,
      q: ctx.url.searchParams.get("q") ?? undefined,
      traceId: ctx.url.searchParams.get("traceId") ?? undefined,
      since: numberParam(ctx, "since"),
      until: numberParam(ctx, "until"),
      limit: clampLimit(numberParam(ctx, "limit"), 200),
    };
    if (persisted) {
      if (!deps.state.sink?.status().available) {
        return json({ enabled: true, persisted: true, available: false, records: [], stats: null });
      }
      return json({
        enabled: true,
        persisted: true,
        available: true,
        records: deps.state.sink.queryLogs(query),
        stats: null,
      });
    }
    return json({
      enabled: true,
      persisted: false,
      records: deps.state.logs.list(query),
      stats: deps.state.logs.stats(),
    });
  };

/** `GET /api/logs/:id` — one full log record for the detail view. */
export const createLogDetailHandler =
  (deps: HandlerDeps) =>
  (rawId: string): Response => {
    const id = Number(decodeURIComponent(rawId));
    if (!Number.isInteger(id) || id < 1) return json({ error: "not_found" }, 404);
    const record = deps.state.logs.getById(id);
    if (!record) {
      return json(
        { error: "not_found", hint: "rotated out of the live log ring or from a previous boot" },
        404,
      );
    }
    return json(record);
  };

/** `POST /api/logs/clear` — drop the in-memory ring. */
export const createLogsClearHandler = (deps: HandlerDeps) => (): Response => {
  deps.state.logs.clear();
  return json({ ok: true, cleared: true });
};

/** `GET /api/metrics` — JSON snapshot. */
export const createMetricsHandler = (deps: HandlerDeps) => (): Response =>
  json(deps.state.metrics.snapshot());

/** `GET /api/metrics/prometheus` — text exposition for scrapers. */
export const createMetricsPrometheusHandler = (deps: HandlerDeps) => (): Response =>
  new Response(deps.state.metrics.prometheus(), {
    status: 200,
    headers: {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    },
  });

/** `GET /api/diagnostics` — leak/trend report (+ persist status). */
export const createDiagnosticsHandler = (deps: HandlerDeps) => (): Response =>
  json({
    ...analyzeSamples(deps.state.profiler.stats().samples),
    persist: deps.state.sink?.status() ?? { enabled: false },
  });

/** `POST /api/diagnostics/gc` — force GC, then report freed memory. */
export const createDiagnosticsGcHandler = () => async (): Promise<Response> => {
  const before = process.memoryUsage();
  const freedBytes = forceGc();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  const after = process.memoryUsage();
  return json({
    ok: true,
    supported: freedBytes > 0 || typeof Bun !== "undefined",
    freedMiB: Math.round((Math.max(0, before.heapUsed - after.heapUsed) / 1024 / 1024) * 10) / 10,
    beforeHeapUsedMiB: Math.round((before.heapUsed / 1024 / 1024) * 10) / 10,
    afterHeapUsedMiB: Math.round((after.heapUsed / 1024 / 1024) * 10) / 10,
  });
};

/** Redaction passthrough — the single seam for a future server-side policy. */
const redact = (trace: RequestTrace): RequestTrace => redactRequestTrace(trace);
