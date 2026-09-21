/**
 * @fileoverview Debugbar tracer types — span kinds, spans, system samples,
 * captured requests and request traces.
 *
 * Extracted from the pre-split `debug/types.ts` (move-only); the other three
 * domain files are `./api`, `./knowledge` and `./observability`, all
 * re-exported by `./index`.
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

/** Handle returned by {@link DebugApi.start} — call `end()` to close the span. */
export interface DebugSpanHandle {
  readonly name: string;
  readonly kind: SpanKind;
  /** End the span (idempotent). */
  end(attrs?: SpanAttrs): void;
  /** End the span as failed with an error. */
  endWithError(err: unknown): void;
}
