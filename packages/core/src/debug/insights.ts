/**
 * @fileoverview Pure application-insight analyzer. Combines retained traces,
 * route metrics, logs and runtime diagnostics into prioritized findings with
 * measured evidence and direct dashboard destinations. No I/O or global state.
 */

import type {
  DebugOverview,
  DiagnosticsReport,
  Insight,
  LogStats,
  MetricsSnapshot,
  RequestTrace,
  Span,
} from "./types";

/** Telemetry inputs used by {@link buildOverview}. */
export interface InsightInput {
  readonly traces: readonly RequestTrace[];
  readonly metrics: MetricsSnapshot;
  readonly diagnostics: DiagnosticsReport;
  readonly logs: LogStats;
  readonly activeRequests: number;
  readonly systemSamples: number;
  readonly persistence: { readonly enabled: boolean; readonly error: string | null };
  readonly checkedAt?: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;
const failed = (trace: RequestTrace): boolean => trace.error !== null || trace.status >= 500;
const routeName = (trace: RequestTrace): string => trace.route || `${trace.method} ${trace.path}`;

const percentile95 = (traces: readonly RequestTrace[]): number => {
  if (traces.length === 0) return 0;
  const values = traces.map((trace) => trace.durationMs).sort((a, b) => a - b);
  return values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;
};

const requestFindings = (traces: readonly RequestTrace[]): Insight[] => {
  if (traces.length === 0) return [];
  const failures = traces.filter(failed);
  const clientErrors = traces.filter((trace) => trace.status >= 400 && trace.status < 500).length;
  const p95Ms = percentile95(traces);
  const findings: Insight[] = [];
  if (failures.length > 0) {
    const first = failures[0] as RequestTrace;
    const rate = (failures.length / traces.length) * 100;
    findings.push({
      id: "request-failures",
      severity: failures.length >= 3 && rate >= 10 ? "critical" : "warning",
      category: "reliability",
      title: `${failures.length} failed request${failures.length === 1 ? "" : "s"}`,
      detail: `${routeName(first)} is the latest failure. ${round(rate)}% of retained requests threw or returned 5xx.`,
      recommendation:
        "Open the failing request, inspect its classified fault and waterfall, then replay it after applying a fix.",
      evidence: {
        failures: failures.length,
        retainedRequests: traces.length,
        failureRatePct: round(rate),
      },
      link: { label: "Open latest failure", view: "detail", id: first.id, tab: "error" },
    });
  }
  if (traces.length >= 10 && clientErrors >= 5 && clientErrors / traces.length >= 0.2) {
    findings.push({
      id: "client-error-spike",
      severity: "warning",
      category: "reliability",
      title: `${clientErrors} client errors in the retained window`,
      detail: `${round((clientErrors / traces.length) * 100)}% of requests returned 4xx. This can indicate a broken client contract, routing drift or an authentication problem.`,
      recommendation:
        "Filter Requests by 4xx, group by path and validation fault, then compare the client payload with the route schema.",
      evidence: { clientErrors, retainedRequests: traces.length },
      link: { label: "Inspect requests", view: "requests" },
    });
  }
  if (traces.length >= 3 && p95Ms >= 1000) {
    const slowest = [...traces].sort((a, b) => b.durationMs - a.durationMs)[0] as RequestTrace;
    findings.push({
      id: "slow-request-window",
      severity: p95Ms >= 3000 ? "critical" : "warning",
      category: "performance",
      title: `Request p95 is ${round(p95Ms)} ms`,
      detail: `The slowest 5% of retained requests exceed the 1 s development budget. Latest slowest: ${routeName(slowest)} at ${round(slowest.durationMs)} ms.`,
      recommendation:
        "Open the waterfall and separate database, outbound HTTP, rendering and unaccounted event-loop time before optimizing.",
      evidence: { p95Ms: round(p95Ms), slowestMs: round(slowest.durationMs), thresholdMs: 1000 },
      link: { label: "Open slowest waterfall", view: "detail", id: slowest.id, tab: "waterfall" },
    });
  }
  return findings;
};

const routeFindings = (metrics: MetricsSnapshot): Insight[] =>
  metrics.routes
    .filter((route) => route.requests >= 3 && route.p95Ms >= 500)
    .sort((a, b) => b.p95Ms - a.p95Ms)
    .slice(0, 3)
    .map((route) => ({
      id: `slow-route:${route.key}`,
      severity: route.p95Ms >= 2000 ? "critical" : "warning",
      category: "performance",
      title: `${route.key} has a slow tail`,
      detail: `p95 is ${route.p95Ms} ms across ${route.requests} requests (p99 ${route.p99Ms} ms).`,
      recommendation:
        "Inspect recent waterfalls for this route and optimize the dominant span; re-check p95 after the change rather than relying on the average.",
      evidence: { requests: route.requests, p95Ms: route.p95Ms, p99Ms: route.p99Ms },
      link: { label: "Open route metrics", view: "metrics" },
    }));

const topLevelDbSpans = (trace: RequestTrace): Span[] => {
  const byId = new Map(trace.spans.map((span) => [span.id, span]));
  return trace.spans.filter((span) => {
    if (span.kind !== "db") return false;
    let parentId = span.parentId;
    while (parentId !== null) {
      const parent = byId.get(parentId);
      if (parent === undefined) return true;
      if (parent.kind === "db") return false;
      parentId = parent.parentId;
    }
    return true;
  });
};

const databaseFindings = (traces: readonly RequestTrace[]): Insight[] => {
  const findings: Insight[] = [];
  for (const trace of traces) {
    const spans = topLevelDbSpans(trace);
    const groups = new Map<string, { name: string; count: number }>();
    for (const span of spans) {
      const key = span.name.trim().replace(/\s+/g, " ").toLowerCase();
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { name: span.name.trim().replace(/\s+/g, " "), count: 1 });
    }
    const repeated = [...groups.values()].sort((a, b) => b.count - a.count)[0];
    if (repeated && repeated.count >= 3) {
      findings.push({
        id: `repeated-query:${trace.id}`,
        severity: repeated.count >= 10 ? "critical" : "warning",
        category: "database",
        title: `Same query ran ${repeated.count} times in one request`,
        detail: `${routeName(trace)} repeated “${repeated.name.slice(0, 180)}”. This is the common N+1 query signature.`,
        recommendation:
          "Batch the lookups, eager-load the relation or add a request-scoped DataLoader; verify the query count drops on replay.",
        evidence: {
          repetitions: repeated.count,
          requestQueries: trace.dbCount,
          dbMs: round(trace.dbTimeMs),
        },
        link: { label: "Inspect queries", view: "detail", id: trace.id, tab: "queries" },
      });
    }
    const slowest = [...spans].sort((a, b) => b.durationMs - a.durationMs)[0];
    if (slowest && slowest.durationMs >= 250) {
      findings.push({
        id: `slow-query:${trace.id}`,
        severity: slowest.durationMs >= 2000 ? "critical" : "warning",
        category: "database",
        title: `Query took ${round(slowest.durationMs)} ms`,
        detail: `${routeName(trace)} spent ${round(trace.dbTimeMs)} ms in ${trace.dbCount} top-level queries; the slowest was “${slowest.name.slice(0, 180)}”.`,
        recommendation:
          "Inspect the query plan and selected columns, add a covering index where appropriate, then replay and compare the waterfall.",
        evidence: {
          queryMs: round(slowest.durationMs),
          requestDbMs: round(trace.dbTimeMs),
          requestQueries: trace.dbCount,
        },
        link: { label: "Inspect queries", view: "detail", id: trace.id, tab: "queries" },
      });
    }
  }
  return findings
    .sort(
      (a, b) =>
        Number(b.evidence.repetitions ?? b.evidence.queryMs ?? 0) -
        Number(a.evidence.repetitions ?? a.evidence.queryMs ?? 0),
    )
    .slice(0, 6);
};

/** Build the complete application overview from current telemetry. */
export const buildOverview = (input: InsightInput): DebugOverview => {
  const { traces } = input;
  const failures = traces.filter(failed);
  const serverErrors = traces.filter((trace) => trace.status >= 500).length;
  const clientErrors = traces.filter((trace) => trace.status >= 400 && trace.status < 500).length;
  const findings: Insight[] = [
    ...requestFindings(traces),
    ...routeFindings(input.metrics),
    ...databaseFindings(traces),
  ];
  if (input.logs.error > 0) {
    findings.push({
      id: "error-logs",
      severity: "warning",
      category: "reliability",
      title: `${input.logs.error} error log${input.logs.error === 1 ? "" : "s"} captured`,
      detail:
        "The live log ring contains application or console errors, including failures that may have been caught before reaching a response.",
      recommendation:
        "Open Logs, inspect structured attributes and follow the request link when a trace id is present.",
      evidence: { errorLogs: input.logs.error, retainedLogs: input.logs.total },
      link: { label: "Open error logs", view: "logs" },
    });
  }
  for (const finding of input.diagnostics.findings) {
    findings.push({
      ...finding,
      category: "runtime",
      evidence: { ...finding.evidence },
      link: { label: "Open diagnostics", view: "diagnostics" },
    });
  }
  if (input.persistence.error !== null) {
    findings.push({
      id: "persistence-error",
      severity: "warning",
      category: "runtime",
      title: "Debug history is not persisting",
      detail: input.persistence.error,
      recommendation:
        "Check the configured SQLite path, directory permissions and available disk space; live debugging remains available.",
      evidence: { persistenceEnabled: input.persistence.enabled ? 1 : 0 },
      link: { label: "Inspect application state", view: "state" },
    });
  }
  const severity = { info: 0, warning: 1, critical: 2 } as const;
  findings.sort((a, b) => severity[b.severity] - severity[a.severity]);
  const durationTotal = traces.reduce((sum, trace) => sum + trace.durationMs, 0);
  return {
    checkedAt: input.checkedAt ?? Date.now(),
    verdict: findings.some((finding) => finding.severity === "critical")
      ? "critical"
      : findings.some((finding) => finding.severity === "warning")
        ? "warning"
        : "ok",
    summary: {
      requests: traces.length,
      failures: failures.length,
      clientErrors,
      serverErrors,
      failureRatePct: traces.length === 0 ? 0 : round((failures.length / traces.length) * 100),
      avgDurationMs: traces.length === 0 ? 0 : round(durationTotal / traces.length),
      p95DurationMs: round(percentile95(traces)),
      activeRequests: input.activeRequests,
      dbQueries: traces.reduce((sum, trace) => sum + trace.dbCount, 0),
      logErrors: input.logs.error,
      uptimeSec: input.metrics.uptimeSec,
    },
    findings: findings.slice(0, 20),
    recentFailures: failures.slice(0, 5).map((trace) => ({
      id: trace.id,
      ts: trace.ts,
      method: trace.method,
      path: trace.path,
      status: trace.status,
      durationMs: trace.durationMs,
      error: trace.error,
      faultCode: trace.fault?.code ?? null,
    })),
    slowRoutes: [...input.metrics.routes].sort((a, b) => b.p95Ms - a.p95Ms).slice(0, 5),
    coverage: {
      retainedTraces: traces.length,
      requestsWithAppSpans: traces.filter((trace) =>
        trace.spans.some((span) => span.kind !== "request" && span.kind !== "lifecycle"),
      ).length,
      requestsWithDb: traces.filter((trace) => trace.dbCount > 0).length,
      systemSamples: input.systemSamples,
      persistence:
        input.persistence.error !== null ? "error" : input.persistence.enabled ? "on" : "off",
    },
  };
};
