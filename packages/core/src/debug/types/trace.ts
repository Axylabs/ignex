/**
 * @fileoverview Debugbar tracer types — span kinds, spans, system samples,
 * captured requests and request traces.
 *
 * Extracted from the pre-split `debug/types.ts` (move-only); the other three
 * domain files are `./api`, `./knowledge` and `./observability`, all
 * re-exported by `./index`.
 *
 * Failures ride the SAME taxonomy as the terminal reporter: a failed trace
 * carries the classified {@link Fault} (`origin`, `kind`, `code`, `retryable`,
 * hints, the sanitized cause chain, `where`) and the span that failed carries
 * the compact {@link FaultMark}. `./fault-capture` builds them, so the
 * dashboard can never disagree with `ignex boot`/request reports.
 */

import type { Fault } from "../../platform/fault-vocabulary";

/**
 * The classified failure attached to a trace — the exact shape the terminal
 * report renders (`renderFault`). A type ALIAS, not a mirror: the dashboard
 * and the error system cannot drift.
 */
export type TraceFault = Fault;

/**
 * Compact classification carried on a trace summary and on a failed span:
 * enough to badge, filter and group a failure without shipping the hint list
 * and cause chain per span.
 */
export interface FaultMark {
  /** Stable machine code (`IGN_DB_CREDENTIALS`, `VALIDATION_ERROR`). */
  readonly code: string;
  /** Which subsystem broke (`db`, `network`, `request`, …). */
  readonly origin: Fault["origin"];
  /** The shape of the failure (`credentials`, `timeout`, `invalid`, …). */
  readonly kind: Fault["kind"];
  /** Named service behind the failure (`MongoDB`, `PostgreSQL`, …). */
  readonly service?: string | undefined;
  /** `file:line:column` of the first application frame, when known. */
  readonly where?: string | undefined;
}

/**
 * What a stack frame is, from the operator's point of view. Drives the "your
 * code" vs "framework & dependencies" split in the Error tab.
 */
export type FrameClass =
  /** Business logic — the application's own routes, models and lib code. */
  | "app"
  /** The ignex framework (core/shared/native/…), installed or linked. */
  | "framework"
  /** A third-party package (`node_modules`). */
  | "dependency"
  /** Compiler output: the bundle, its entry shim, the `.ignex` build dir. */
  | "generated"
  /** A synthesized runtime frame (`native:`, `node:`) — names no file. */
  | "synthetic"
  /** Not a frame line at all. */
  | "none";

/**
 * A failure's frames, split the way an operator reads them: business logic
 * first, the machinery that carried the failure after.
 *
 * Both groups are needed — the second explains the first — but only the first
 * is where the fix goes. `appWhere` is the location in the application's own
 * code; it exists even when the error's own stack has no application frame
 * (Bun truncates async stacks at `processTicksAndRejections`, so a dependency
 * error is traced back through the span that started the work).
 */
export interface TraceFrames {
  /** Business-logic frames, in capture order (the error's own stack first). */
  readonly app: readonly string[];
  /** Framework, dependency and generated frames, in capture order. */
  readonly internal: readonly string[];
  /** The location in the application's own code where the failure surfaces. */
  readonly appWhere?: string | undefined;
}

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
  /**
   * Classification of the failure that ended this span (`code`/`origin`/
   * `kind`) — the waterfall badge says WHICH subsystem broke, not just that
   * something did. Absent on a span that succeeded.
   */
  fault?: FaultMark | null;
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
  /**
   * The classified failure behind {@link RequestTrace.error} — origin, kind,
   * code, retryable verdict, operator hints, the sanitized `cause` chain
   * (never the raw driver object) and the first application frame. This is
   * what turns "500 on POST /api/gigs" into "MongoDB rejected the credentials;
   * check `MONGO_URL`; the driver said code 13". Absent when the request
   * succeeded.
   */
  readonly fault?: TraceFault | null;
  /**
   * Id of the span that failed (the innermost span open when the error was
   * recorded, or `null` when the request failed outside any span). Lets the
   * dashboard point the waterfall at the failing stage.
   */
  readonly faultSpanId?: number | null;
  /**
   * The failure as frames — your code first, the machinery after — so the Error
   * tab (and an MCP agent) leads with the business location instead of a
   * driver's internals. Absent when the request succeeded.
   */
  readonly faultFrames?: TraceFrames | null;
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
