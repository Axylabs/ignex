/**
 * @fileoverview Observatory types — structured logs, Prometheus-style metrics,
 * leak/trend diagnostics, persistence status, history and app-state snapshots.
 *
 * Extracted from the pre-split `debug/types.ts` (move-only); the other three
 * domain files are `./trace`, `./api` and `./knowledge`, all re-exported by
 * `./index`.
 */

import type { FaultMark, SpanAttrs } from "./trace";

/* ============================================================================
 * Observatory — structured logs, metrics, leak diagnostics, app state.
 *
 * These are the second-generation debugbar surfaces: everything the log
 * recorder emits, the metrics registry aggregates, the leak detector reports
 * and the state inspector snapshots is declared here so the dashboard JSON
 * contract stays explicit (the same discipline as the tracer types above).
 * ==========================================================================*/

/** Severity of an observatory log record. Ordered: debug < info < warn < error. */
export type LogLevel =
  /** Fine-grained developer detail (noisy by design). */
  | "debug"
  /** Normal operational events. */
  | "info"
  /** Something suspicious but handled. */
  | "warn"
  /** A failure that was surfaced. */
  | "error";

/**
 * One structured log record captured by the observatory.
 *
 * Records are correlated to the request they happened in (via the ALS trace)
 * whenever `debugLog()` / `ctx.debug.log()` runs inside a request's async
 * chain — click a trace id in the Logs panel to jump straight to the request
 * waterfall that produced the line.
 */
export interface LogRecord {
  /** Monotonic id within the recorder (stable sort + stable React-less keys). */
  readonly id: number;
  /** Wall-clock epoch ms. */
  readonly ts: number;
  readonly level: LogLevel;
  /** Human-readable line (already flattened when captured from console). */
  readonly message: string;
  /** Structured extra fields (JSON-safe). */
  readonly attrs: SpanAttrs | null;
  /** Correlated request trace id, when recorded inside a traced request. */
  readonly traceId: string | null;
  /** Correlated request id (same value as {@link RequestTrace.requestId}). */
  readonly requestId: string | null;
  /** Matched route pattern (e.g. `/users/:id`), when known. */
  readonly route: string | null;
  /**
   * Origin of the record: `"app"` (debugLog / ctx.debug.log), `"console"`
   * (captured console.* call) or `"framework"` (plugin/lifecycle notices).
   */
  readonly source: string;
}

/** Per-level counters served alongside the log list. */
export interface LogStats {
  readonly total: number;
  readonly debug: number;
  readonly info: number;
  readonly warn: number;
  readonly error: number;
}

/** Filter shape accepted by the log store and the `/api/logs` endpoint. */
export interface LogQuery {
  /** Minimum level to include (inclusive; default "debug"). */
  readonly minLevel?: LogLevel | undefined;
  /** Case-insensitive substring over `message`. */
  readonly q?: string | undefined;
  /** Only records emitted inside this request trace. */
  readonly traceId?: string | undefined;
  /** Inclusive lower bound (epoch ms). */
  readonly since?: number | undefined;
  /** Inclusive upper bound (epoch ms). */
  readonly until?: number | undefined;
  /** Max rows returned (default 200). */
  readonly limit?: number | undefined;
}

/**
 * One Prometheus-style histogram (cumulative buckets + sum/count).
 * Buckets are fixed at registry construction so exposition stays diff-stable.
 */
export interface HistogramSnapshot {
  /** Upper bounds in the same unit as observed values (ms), ascending. */
  readonly bounds: number[];
  /** Cumulative observation count per bound (index-aligned with `bounds`). */
  readonly counts: number[];
  /** Observations above the highest bound land in the implicit +Inf bucket. */
  readonly overflow: number;
  /** Sum of all observed values. */
  readonly sum: number;
  /** Total observations (= overflow + Σcounts). */
  readonly count: number;
}

/** Aggregated metrics for one route pattern (`GET /users/:id`). */
export interface RouteMetrics {
  /** Method + route-pattern key (the label used in Prometheus exposition). */
  readonly key: string;
  readonly requests: number;
  /** Responses with status ≥ 400 or a captured error. */
  readonly errors: number;
  /** Cumulative wall duration (ms). */
  readonly totalMs: number;
  /** Estimated quantiles from the histogram (ms). */
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly dbQueries: number;
  readonly dbMs: number;
  readonly lastStatus: number;
  /** Epoch ms of the most recent observed request. */
  readonly lastTs: number;
}

/** Full JSON snapshot served by `/api/metrics` (dashboard + MCP). */
export interface MetricsSnapshot {
  readonly startedAt: number;
  readonly uptimeSec: number;
  readonly totals: {
    requests: number;
    errors: number;
    status2xx: number;
    status3xx: number;
    status4xx: number;
    status5xx: number;
    dbQueries: number;
  };
  /** Named gauges (rss/heap/event-loop/active requests — updated per sample). */
  readonly gauges: Record<string, number>;
  /** Custom counters registered by the app (`counter(name, labels?)`). */
  readonly counters: Array<{ name: string; labels: SpanAttrs; value: number }>;
  /** Per-route aggregates, busiest first. */
  readonly routes: RouteMetrics[];
  /** Duration histogram config (ms bounds) for chart scaling. */
  readonly durationBucketsMs: number[];
}

/**
 * One detected anomaly from the observatory's leak/trend analyzer.
 * Findings carry their evidence inline (slope, R², window) so both humans
 * and AI agents can act without re-computing anything.
 */
export interface LeakFinding {
  /** Stable rule id (e.g. `heap-growth`) — safe to alert/dedupe on. */
  readonly id: string;
  readonly severity: "info" | "warning" | "critical";
  readonly title: string;
  /** Plain-language explanation of what was measured. */
  readonly detail: string;
  /** Measured evidence (slope/rate/window/thresholds) — numbers, not prose. */
  readonly evidence: Record<string, number>;
  /** What to do next, concretely. */
  readonly recommendation: string;
}

/** Full diagnostics report served by `/api/diagnostics`. */
export interface DiagnosticsReport {
  /** Worst-severity rollup: `ok` when there are no findings. */
  readonly verdict: "ok" | "warning" | "critical";
  readonly checkedAt: number;
  /** Time span covered by the analyzed samples, in minutes. */
  readonly windowMin: number;
  readonly samplesAnalyzed: number;
  readonly findings: LeakFinding[];
  /** Headline trends (always present, even when healthy). */
  readonly trend: {
    /** Least-squares slope of heap-used over the window (MiB/min). */
    readonly heapMiBPerMin: number;
    /** Fit quality of the heap trend (0–1; low R² = noise, not a trend). */
    readonly heapR2: number;
    readonly heapNowMiB: number;
    readonly heapMinMiB: number;
    readonly heapMaxMiB: number;
    readonly rssMiBPerMin: number;
    /** p95 event-loop delay across the window (ms). */
    readonly eventLoopP95Ms: number;
    /** Peak in-flight requests across the window. */
    readonly activeRequestsMax: number;
  };
}

/** Live status of the SQLite observatory persistence layer. */
export interface PersistStatus {
  /** Persistence configured AND the SQLite module loaded. */
  readonly enabled: boolean;
  /** Absolute database file path (null for `:memory:`). */
  readonly path: string | null;
  /** True when `bun:sqlite` is usable in this runtime. */
  readonly available: boolean;
  /** Records buffered but not yet written. */
  readonly queued: number;
  /** Total records written since boot. */
  readonly written: number;
  readonly lastFlushAt: number | null;
  readonly lastPruneAt: number | null;
  /** Row counts per table (best-effort; null while the db is opening). */
  readonly rows: { traces: number | null; logs: number | null; samples: number | null };
  readonly error: string | null;
}

/** Compact history row (persisted, cross-restart) served by `/api/history`. */
export interface HistoryTraceSummary {
  readonly id: string;
  readonly ts: number;
  readonly method: string;
  readonly path: string;
  readonly route: string | null;
  readonly status: number;
  readonly durationMs: number;
  readonly error: string | null;
  /** Compact classification of the failure, when the request failed. */
  readonly fault?: FaultMark | null;
  readonly dbCount: number;
  readonly dbTimeMs: number;
  readonly spanCount: number;
}

/** Filters accepted by the persisted-history query (`/api/history`). */
export interface HistoryQuery {
  readonly since?: number | undefined;
  readonly until?: number | undefined;
  /** Substring match over method + path + error. */
  readonly q?: string | undefined;
  readonly method?: string | undefined;
  /** Status family ("2xx" | "3xx" | "4xx" | "5xx") or exact number as string. */
  readonly status?: string | undefined;
  /** Exact fault-code match (`IGN_DB_CREDENTIALS`), applied post-query. */
  readonly code?: string | undefined;
  /** Only failed requests. */
  readonly errorsOnly?: boolean | undefined;
  readonly minDurationMs?: number | undefined;
  readonly limit?: number | undefined;
}

/** Snapshot of application + process state served by `/api/state`. */
export interface AppStateSnapshot {
  readonly service: string;
  readonly version: string;
  readonly environment: string;
  readonly debugMode: boolean;
  readonly runtime: {
    readonly bunVersion: string;
    readonly platform: string;
    readonly arch: string;
    readonly pid: number;
    readonly nodeEnv: string;
    readonly startedAt: number;
    readonly uptimeSec: number;
  };
  /** Current memory breakdown (MiB, rounded). */
  readonly memory: {
    readonly rssMiB: number;
    readonly heapUsedMiB: number;
    readonly heapTotalMiB: number;
    readonly externalMiB: number;
    readonly arrayBuffersMiB: number;
  };
  /** Environment variable NAMES visible to the process (values are never included). */
  readonly envKeys: string[];
  readonly routes: number;
  readonly plugins: string[];
  readonly stores: {
    readonly tracesRetained: number;
    readonly logsRetained: number;
    readonly activeRequests: number;
  };
  /** Feature flags so dashboards/MCP can adapt to what is wired. */
  readonly features: { logs: boolean; metrics: boolean; persist: boolean };
}
