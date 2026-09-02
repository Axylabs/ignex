/**
 * @fileoverview Debugbar shared types — spans, request traces, system samples.
 *
 * These are the wire types of the debug dashboard: every structure the tracer
 * produces, the store retains, and the `/__debugbar/api/*` endpoints serialize
 * is declared here so the dashboard JSON contract stays explicit.
 */

/** What a span represents. Drives the waterfall color + grouping in the UI. */
export type SpanKind =
  /** The request itself (root span). */
  | "request"
  /** Framework lifecycle stage (start/request/parse/transform/beforeHandle/handler/afterHandle/mapResponse/response). */
  | "lifecycle"
  /** A database query or transaction. */
  | "db"
  /** A cache get/set/invalidate (in-memory, Redis, CDN, …). */
  | "cache"
  /** An outbound HTTP/fetch call. */
  | "http"
  /** File/static serving or a template render. */
  | "render"
  /** Auth / sessions / security checks. */
  | "auth"
  /** Any other app-defined work. */
  | "custom"
  /** A failed operation. */
  | "error";

/** Metadata attached to a span (query text, target URL, note, …). */
export type SpanAttrs = Record<string, unknown>;

/** One timed unit of work inside a request. */
export interface Span {
  /** Stable id within the trace (parent links reference it). */
  readonly id: number;
  /** Parent span id; `null` for the root span. */
  readonly parentId: number | null;
  readonly name: string;
  readonly kind: SpanKind;
  /** Milliseconds since the request started (monotonic, `performance.now()`). */
  readonly startMs: number;
  /** Duration in milliseconds (filled on end; mutable while the span is open). */
  durationMs: number;
  /** True when the span is still open (never ended — request was cut short). */
  open: boolean;
  attrs: SpanAttrs | null;
  /** Error message when this span failed, else null. */
  error: string | null;
  /** Stack frame top when the span was created (first non-debug frame). */
  readonly origin: string | null;
}

/** A single system sample (CPU / memory / event-loop health at a moment). */
export interface SystemSample {
  /** Wall-clock epoch ms at sampling time (persisted + pruned by this value). */
  readonly ts: number;
  /**
   * Process CPU over the last sample interval, as a percentage of ONE core
   * (0–∞, can exceed 100 on multicore). 100 = one core fully busy.
   */
  readonly cpuPct: number;
  /** RSS in MiB. */
  readonly rssMiB: number;
  /** Heap used in MiB. */
  readonly heapMiB: number;
  /** Event-loop delay observed by a staggered timer, ms. */
  readonly eventLoopDelayMs: number;
  /** Requests currently in flight (measured at sample time). */
  readonly activeRequests: number;
}

/** System-profile summary served to the dashboard. */
export interface SystemStats {
  readonly sampling: boolean;
  readonly sampleMs: number;
  readonly samples: SystemSample[];
  readonly startedAt: number;
  readonly uptimeSec: number;
  readonly totals: {
    requests: number;
    errors: number;
    avgDurationMs: number;
    p95DurationMs: number;
  };
}

/** HTTP request snapshot captured for the trace + replay. */
export interface CapturedRequest {
  readonly method: string;
  /** Absolute URL of the original request. */
  readonly url: string;
  /**
   * Request headers. Kept RAW on the trace so replay is faithful; the
   * dashboard API redacts sensitive values via `redactRequestTrace`.
   */
  headers: Record<string, string>;
  /** Raw body text; present only when `captureBody` is enabled. */
  body: string | null;
}

/** One captured request, ready for the dashboard + replay. */
export interface RequestTrace {
  readonly id: string;
  /** Wall-clock epoch ms when the request started (dashboard + persistence). */
  readonly ts: number;
  /** Epoch start time (mirrors {@link RequestTrace.ts}); durations are monotonic. */
  readonly startedAtMs: number;
  /** End-to-end duration in milliseconds. */
  readonly durationMs: number;
  readonly method: string;
  readonly path: string;
  readonly route: string;
  readonly status: number;
  readonly requestId: string;
  readonly ip: string;
  readonly error: string | null;
  readonly errorStack: string | null;
  readonly request: CapturedRequest;
  /** Redacted response headers. */
  readonly responseHeaders: Record<string, string> | null;
  /**
   * Captured response body text — present when `captureBody` is on and the
   * response was textual (JSON/text/XML/…; streams, SSE and binary are
   * skipped) and within the size cap. Mutable: the trace store sheds body
   * text from old captures when the retention budget fills.
   */
  responseBody: string | null;
  /** True when {@link RequestTrace.responseBody} hit the size cap. */
  responseBodyTruncated: boolean;
  readonly spans: Span[];
  /** Total DB time (sum of `db` spans) — the headline query metric. */
  readonly dbTimeMs: number;
  /** Total number of recorded DB spans. */
  readonly dbCount: number;
  /** Names of the lifecycle stages observed for this request. */
  readonly stages: string[];
}

/**
 * `/api/requests/:id` response — the full trace plus reproduction aids
 * attached by the plugin layer (never produced by {@link Trace.toJSON}).
 */
export interface TraceDetail extends RequestTrace {
  /** One-click reproduction command (built from ALREADY-redacted headers). */
  readonly curl?: string;
  /**
   * Repo-relative source file of the matched route (e.g.
   * `src/routes/users/[id].get.ts`), resolved from the AOT manifest. Null
   * when unknown (runtime-registered route, no manifest).
   */
  readonly sourceFile?: string | null;
}

/** Per-request API exposed as `ctx.debug` (no-op when the plugin is absent). */
export interface DebugApi {
  /**
   * Run `fn` inside an auto-timed span of the given kind. The span is recorded
   * even when `fn` throws (as an error span) and the error is rethrown.
   */
  span<T>(name: string, kind: SpanKind, fn: () => T | Promise<T>, attrs?: SpanAttrs): Promise<T>;
  /** Start a manual span; end it with the returned handle (for interleaved work). */
  start(name: string, kind?: SpanKind, attrs?: SpanAttrs): DebugSpanHandle;
  /**
   * Record a database query (timed automatically when `fn` is provided).
   * `params` is WHAT WAS SENT — positional SQL binds (array), a Mongo
   * filter/options document (object) or any JSON-safe payload; it is stored
   * verbatim on the span and rendered by the dashboard's Queries tab.
   */
  query(sql: string, params?: unknown, fn?: () => unknown | Promise<unknown>): Promise<unknown>;
  /**
   * Record a completed cache operation. The span is always closed
   * immediately; when {@link cache.durationMs} is provided it becomes the
   * span's waterfall duration (caller-measured), otherwise ~0ms.
   */
  cache(hit: boolean, label: string, durationMs?: number, attrs?: SpanAttrs): void;
  /** Time an outbound HTTP call and record it as an `http` span. */
  http(label: string, fn: () => Response | Promise<Response>): Promise<Response>;
  /** Attach an instantaneous event/note to the trace (zero duration). */
  event(name: string, attrs?: SpanAttrs): void;
  /** Record an error against this request (surfaces in the errors view). */
  error(err: unknown, attrs?: SpanAttrs): void;
  /**
   * Record a structured observatory log line, correlated to this request.
   * No-op when no log store is installed (debugbar absent / debug off).
   */
  log(level: LogLevel, message: string, attrs?: SpanAttrs): void;
}

/** Handle returned by {@link DebugApi.start} — call `end()` to close the span. */
export interface DebugSpanHandle {
  readonly name: string;
  readonly kind: SpanKind;
  /** End the span (idempotent). */
  end(attrs?: SpanAttrs): void;
  /** End the span as failed with an error. */
  endWithError(err: unknown): void;
}

/** Shape of the plugin's captured app knowledge for the KT page. */
export interface AppKnowledge {
  readonly serviceName: string;
  readonly version: string;
  readonly debugMode: boolean;
  readonly environment: Record<string, string>;
  readonly runtime: {
    bunVersion: string;
    platform: string;
    arch: string;
    pid: number;
    nodeEnv: string;
    startedAt: number;
    uptimeSec: number;
  };
  readonly routes: KnowledgeRoute[];
  readonly plugins: KnowledgePlugin[];
  readonly lifecycle: KnowledgeStage[];
  readonly spanKinds: SpanKind[];
  readonly sdk: KnowledgeSdk | null;
  /** Conventional project areas probed on disk — the "where things live" map. */
  readonly areas: KnowledgeArea[];
  /** Markdown docs discovered in the repo — the documentation inventory. */
  readonly docs: KnowledgeDoc[];
  /**
   * DB activity aggregated over the retained request traces (normalized
   * statements with call counts, total time and the routes that ran them).
   */
  readonly dbActions: KnowledgeDbAction[];
  readonly notes: string[];
}

/** One route in the KT route map. */
export interface KnowledgeRoute {
  readonly method: string;
  readonly path: string;
  readonly file: string | null;
  readonly description: string;
  /** Human summary of the context members the handler touches. */
  readonly usage: string[];
  readonly isConstant: boolean;
  readonly hooks: string[];
}

/** One registered plugin in the KT inventory. */
export interface KnowledgePlugin {
  readonly name: string;
  readonly description: string;
}

/** One lifecycle stage with its hook count. */
export interface KnowledgeStage {
  readonly name: string;
  readonly hookCount: number;
  readonly order: number;
}

/** One conventional project area in the KT "where things live" map. */
export interface KnowledgeArea {
  readonly name: string;
  /** Directory that was probed (relative to the app root). */
  readonly dir: string;
  /** What this area is for, in onboarding language. */
  readonly description: string;
  /** Total files found under the area (recursive, any extension). */
  readonly fileCount: number;
  /** Sample of the files found (relative to the area), capped for display. */
  readonly files: string[];
}

/** One markdown document discovered for the KT documentation inventory. */
export interface KnowledgeDoc {
  /** Repo-relative path (the stable identifier — docs move less than URLs). */
  readonly path: string;
  /** Title from the first `#` heading; falls back to the file name. */
  readonly title: string;
}

/** Aggregated DB activity for one normalized SQL pattern. */
export interface KnowledgeDbAction {
  /** Leading SQL keyword uppercased (`SELECT`, `INSERT`, …). */
  readonly action: string;
  /** First table referenced (`from`/`into`/`update`/`join`), when parseable. */
  readonly table: string | null;
  /** Statement shape with literals replaced by `?` and whitespace collapsed. */
  readonly statement: string;
  /** How many times it ran inside the retained traces. */
  readonly calls: number;
  /** Sum of span durations (ms) across those calls. */
  readonly totalMs: number;
  /** Route patterns observed performing this action (capped sample). */
  readonly routes: string[];
}

/** Published-SDK metadata shown on the KT page. */
export interface KnowledgeSdk {
  readonly name: string;
  readonly version: string;
  readonly location: string;
  readonly files: string[];
  /** Git tags matching the SDK tag prefix (`sdk-v*`), newest first. */
  readonly gitTags: string[];
  /** `tagged` when a matching git tag exists (the `ignex sdk --push` signal). */
  readonly published: "tagged" | "local" | "unknown";
}

/**
 * Compact AI-facing debug summary served at `{path}/api/ai/summary`.
 *
 * One small JSON document that tells an AI agent (via MCP) what is happening
 * on this server right now: error/slow traces, event-queue stats and published
 * clients. Designed to be cheap to fetch and cheap to read — the agent then
 * drills into specific traces with the per-request endpoints.
 */
export interface AiDebugSummary {
  readonly service: string;
  readonly version: string;
  readonly environment: string;
  readonly uptimeSec: number;
  readonly traces: {
    readonly total: number;
    readonly errors: number;
    readonly avgDurationMs: number;
    readonly p95DurationMs: number;
    /** Most recent failed requests (compact rows). */
    readonly recentErrors: Array<{
      id: string;
      ts: number;
      method: string;
      path: string;
      status: number;
      error: string;
    }>;
    /** Slowest retained requests. */
    readonly slowest: Array<{
      id: string;
      ts: number;
      method: string;
      path: string;
      durationMs: number;
      status: number;
    }>;
  };
  readonly events: {
    readonly enabled: boolean;
    readonly connected: boolean;
    readonly total: number;
    readonly errors: number;
    readonly bySubject: Record<string, number>;
  };
  readonly clients: Array<{
    readonly kind: string;
    readonly platform: string | null;
    readonly name: string;
    readonly version: string;
    readonly published: string;
    readonly gitTags: readonly string[];
  }>;
  /**
   * Nova (FlatBuffer realtime transport) event activity — present when the
   * app wires `data.nova` into the debugbar. What fired recently, at a glance.
   */
  readonly nova?: {
    /** trace ring active on the running nova server */
    readonly enabled: boolean;
    /** records currently retained by the ring */
    readonly size: number;
    readonly total: number;
    readonly inCount: number;
    readonly outCount: number;
    /** per-event counts over the retained window */
    readonly byName: Record<string, number>;
    /** most recent fired events, newest first (compact rows) */
    readonly recent: Array<{
      ts: number;
      direction: string;
      name: string;
      target?: string;
      key?: string;
      bytes: number;
    }>;
  };
  /**
   * Observatory addendum — leak verdict, recent warnings and persistence
   * state, so an agent can decide where to dig next without extra calls.
   */
  readonly observatory?: {
    readonly verdict: "ok" | "warning" | "critical";
    readonly findings: Array<{
      readonly id: string;
      readonly severity: "info" | "warning" | "critical";
      readonly title: string;
    }>;
    /** Current heap trend (MiB/min; ~0 when healthy). */
    readonly heapMiBPerMin: number;
    readonly logErrors: number;
    readonly recentWarnings: Array<{
      readonly ts: number;
      readonly level: string;
      readonly message: string;
      readonly traceId?: string;
    }>;
    readonly persist: { readonly enabled: boolean; readonly path: string | null };
  };
  readonly routes: number;
}

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

/** Options for {@link KnowledgeBuilder}. */
export interface KnowledgeOptions {
  readonly serviceName: string;
  readonly version?: string;
  /** AOT manifest.json artifact path(s) to read the route map from. */
  readonly manifestPaths?: string[];
  /** SDK package/location probes (directory containing package.json or the json itself). */
  readonly sdkPaths?: string[];
  /**
   * Directories scanned for the documentation inventory (markdown files, two
   * levels deep). Defaults to `["docs", "."]` relative to {@link projectRoot}.
   */
  readonly docsPaths?: string[];
  /** App root the project map + docs scan probe. Default `process.cwd()`. */
  readonly projectRoot?: string;
  /** Lifecycle stage inventory (name → hook count), in execution order. */
  readonly lifecycle?: Record<string, number>;
  readonly plugins?: string[];
}

/* ============================================================================
 * Events panel — the unified event buffer (NATS pub/sub + nova/WS realtime).
 *
 * The debugbar's Events view is a single buffer that interleaves two
 * transports so you can see, side by side, what your app SENT and what it
 * RECEIVED over the wire:
 *   - `nats` — messages published / received over the NATS bus
 *     (`NatsEventTracker`, tracked push-style into its ring).
 *   - `nova` — events that fired in the app's typed realtime transport
 *     (`@ignex/nova`): server→client emits/publishes, client→server inbound,
 *     cluster-sync and NATS-bridge inbound. Read from nova's own trace ring
 *     via the `data.nova` probe.
 *
 * Contract served by `GET /api/events` and rendered by `ui/views/events.tsx`.
 * ==========================================================================*/

/** Transport an event-buffer row came from. */
export type DebugEventSource = "nats" | "nova";

/** One row in the unified Events panel buffer. */
export interface DebugEventRow {
  /** Stable id within the buffer (`ev-…` for nats, `nv-<seq>` for nova). */
  readonly id: string;
  /** Epoch ms when the event was recorded. */
  readonly ts: number;
  readonly source: DebugEventSource;
  /** `out` = this process sent it, `in` = this process received it. */
  readonly direction: "in" | "out";
  /**
   * Precise kind behind the direction pill:
   * nats → `publish` | `message`; nova → `publish` | `emit` | `client`
   * (received from a WS client) | `remote` | `bridge`.
   */
  readonly kind: string;
  /** Subject (nats) or wire event name (nova), e.g. `orders.created`. */
  readonly name: string;
  /** Nova target key (user/topic/group/client id) when addressed. */
  readonly key?: string;
  /** Truncated JSON payload preview (`""` when capture is off or empty). */
  readonly payload: string;
  /** Wire size in bytes. */
  readonly size: number;
  /** Error message when the send/recv failed, else null. */
  readonly error: string | null;
}

/** Per-source summary for the unified Events panel header. */
export interface DebugEventSourceInfo {
  /** True when the source is wired and producing data. */
  readonly present: boolean;
  /** Human label: `NATS bus` | `Nova realtime (WS)`. */
  readonly label: string;
  /** NATS connection state (nats only). */
  readonly connected?: boolean;
  readonly status?: string;
  /** Retained rows in the buffer/ring (≤ capacity). */
  readonly size: number;
  /** Rows written since the buffer started. */
  readonly total: number;
  readonly in: number;
  readonly out: number;
  readonly errors: number;
  readonly bytes: number;
  /** Per-subject (nats) / per-event (nova) counts over the window. */
  readonly byName: Record<string, number>;
  /**
   * Nova only: whether the ring is capturing truncated JSON payload previews
   * (`undefined` for nats, which always stores payloads).
   */
  readonly captures?: boolean;
  /** Present when the source could not be probed: guidance text. */
  readonly hint?: string;
}

/** `GET /api/events` — the unified Events panel payload. */
export interface DebugEventsPayload {
  /** True when at least one source is wired (NATS and/or nova). */
  readonly enabled: boolean;
  /** Shown when NOTHING is wired: how to turn on either source. */
  readonly hint?: string;
  readonly sources: {
    readonly nats: DebugEventSourceInfo | null;
    readonly nova: DebugEventSourceInfo | null;
  };
  /** Interleaved rows, newest first, capped by `limit`. */
  readonly recent: DebugEventRow[];
}
