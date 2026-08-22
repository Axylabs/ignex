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
  readonly ts: number;
  /** Process CPU since boot, as a percentage of one core (0–∞, can exceed 100 on multicore). */
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
  readonly ts: number;
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
  readonly spans: Span[];
  /** Total DB time (sum of `db` spans) — the headline query metric. */
  readonly dbTimeMs: number;
  /** Total number of recorded DB spans. */
  readonly dbCount: number;
  /** Names of the lifecycle stages observed for this request. */
  readonly stages: string[];
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
  /** Record a database query (timed automatically when `fn` is provided). */
  query(sql: string, params?: unknown[], fn?: () => unknown | Promise<unknown>): Promise<unknown>;
  /** Record a cache operation with a known duration. */
  cache(hit: boolean, label: string, durationMs?: number, attrs?: SpanAttrs): void;
  /** Time an outbound HTTP call and record it as an `http` span. */
  http(label: string, fn: () => Response | Promise<Response>): Promise<Response>;
  /** Attach an instantaneous event/note to the trace (zero duration). */
  event(name: string, attrs?: SpanAttrs): void;
  /** Record an error against this request (surfaces in the errors view). */
  error(err: unknown, attrs?: SpanAttrs): void;
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
  readonly routes: number;
}

/** Options for {@link KnowledgeBuilder}. */
export interface KnowledgeOptions {
  readonly serviceName: string;
  readonly version?: string;
  /** AOT manifest.json artifact path(s) to read the route map from. */
  readonly manifestPaths?: string[];
  /** SDK package/location probes (directory containing package.json or the json itself). */
  readonly sdkPaths?: string[];
  /** Lifecycle stage inventory (name → hook count), in execution order. */
  readonly lifecycle?: Record<string, number>;
  readonly plugins?: string[];
}
