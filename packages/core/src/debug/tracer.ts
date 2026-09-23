/**
 * @fileoverview Request tracer — span trees, per-request traces, ALS context.
 *
 * A `Tracer` owns the per-request `Trace` objects. The debugbar plugin begins
 * a trace in its `onRequest` hook and seeds the process-wide
 * `AsyncLocalStorage` with it via `enterWith()` — from that point on, ANY code
 * in the request's async chain (handlers, DB drivers, SDKs) can record spans
 * through the free functions (`debugSpan`, `debugQuery`, …) without holding a
 * reference to `ctx`. When no trace is active (production, plugin absent,
 * background work) those helpers degrade to zero-overhead pass-throughs.
 *
 * `enterWith` propagation was verified against Bun 1.4: a store entered inside
 * a hook that runs synchronously inside the request pipeline is inherited by
 * every subsequent `await` in that pipeline (handler + post stages), and
 * concurrent requests never observe each other's stores.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { IgnexContext } from "../http/context";
import { setRequestFrameResolver } from "../platform/fault-report";
import { faultAttrs, markOf, traceFault } from "./fault-capture";
import { callerOrigin, captureErrorStack, failingOrigin, summarizeFailureFrames } from "./frames";
import { captureRedactedHeaders, clipBody, isRedactedHeader } from "./redaction";
import { installSourceFrames } from "./sourcemaps";
import { defaultSpanIds, type SpanIdSource } from "./span-id";
import type {
  CapturedRequest,
  RequestTrace,
  Span,
  SpanAttrs,
  SpanKind,
  TraceFault,
  TraceFrames,
} from "./types";

/** The per-request ALS payload. */
export interface TraceContext {
  readonly trace: Trace;
}

/**
 * Process-wide context: every active request's trace, plus a guard so
 * `currentTrace()` is cheap when the debugbar plugin is not installed.
 */
const traceContext = new AsyncLocalStorage<TraceContext>();
/** Set by the plugin at boot; cleared only for tests. */
let tracingEnabled = false;
/** Whether {@link setTracingEnabled} has been called at least once. */
let tracingConfigured = false;

/**
 * Enable/disable ALS propagation for the whole process (debugbar plugin boot).
 *
 * A change AFTER the first configuration is suspicious — a second plugin or
 * boot path toggling ambient process state — so it logs a warning while still
 * applying the change. Idempotent re-sets (same value) stay silent.
 */
export const setTracingEnabled = (enabled: boolean): void => {
  if (tracingConfigured && enabled !== tracingEnabled) {
    console.warn(
      `[ignex:tracer] tracing ${enabled ? "enabled" : "disabled"} after it was already configured — check for a second tracer plugin/boot path`,
    );
  }
  tracingEnabled = enabled;
  tracingConfigured = true;
  if (enabled) {
    installSourceFrames(); // frames resolve to `.ts`, not the bundle
    // …and the terminal report can name the application line that reached the
    // failure, which the error's own stack lost at the async boundary.
    setRequestFrameResolver(() => currentTrace()?.faultFrames?.appWhere);
  }
};

/** True when a debug tracer is installed for this process. */
export const isTracingEnabled = (): boolean => tracingEnabled;

/** The trace of the currently-executing request, or `undefined`. */
export const currentTrace = (): Trace | undefined =>
  tracingEnabled ? traceContext.getStore()?.trace : undefined;

/** The trace of the currently-executing request as a raw context payload. */
export const currentTraceContext = (): TraceContext | undefined =>
  tracingEnabled ? traceContext.getStore() : undefined;

/** Seed the ALS for the remainder of the current request pipeline. */
export const enterTraceContext = (trace: Trace): void => {
  traceContext.enterWith({ trace });
};

/**
 * Record that a lifecycle stage finished (framework-side). The stage that
 * creates the trace (the debugbar plugin's `request` stage) cannot be wrapped
 * in a span while it runs — the trace does not exist yet — so the pipeline
 * calls this the moment the stage returns. No-op when no trace is active.
 */
export const debugStageEnd = (name: string): void => {
  currentTrace()?.recordStage(name);
};

// ============================================================================
// Trace
// ============================================================================

// ============================================================================

/**
 * Lifecycle stage names the framework records as spans (`runTimed` /
 * `recordStage`). These are framework-managed: a stage may still be open when
 * the debugbar finalizes the trace inside the afterHandle stage, so finalize
 * closes them without the "left open" leak flag.
 */
const FRAMEWORK_STAGE_NAMES = new Set([
  "start",
  "request",
  "parse",
  "transform",
  "beforeHandle",
  "handler",
  "afterHandle",
  "mapResponse",
  "afterResponse",
  "trace",
  "error",
  "route hooks",
  "response",
]);

/** True when `span` is a framework lifecycle-stage row (not an app span). */
const isFrameworkStageSpan = (span: Span): boolean =>
  span.kind === "lifecycle" && FRAMEWORK_STAGE_NAMES.has(span.name);

/**
 * One request's trace: the span tree plus request/response metadata. App code
 * normally never touches this directly — it uses `ctx.debug` (the plugin
 * injects it) or the `debugSpan`/`debugQuery` free functions.
 */
export class Trace {
  readonly id: string;
  readonly startedAtMs: number;
  /** Wall-clock start (epoch ms) — the value serialized as `ts`. */
  readonly startedAtEpochMs: number;
  readonly method: string;
  readonly path: string;
  readonly route: string;
  readonly requestId: string;
  readonly ip: string;

  readonly request: CapturedRequest;
  status = 0;
  responseHeaders: Record<string, string> | null = null;
  /** Captured response body (set by the plugin when body capture is on). */
  responseBody: string | null = null;
  responseBodyTruncated = false;
  error: string | null = null;
  errorStack: string | null = null;
  /** Classification of the request failure (the wire-safe `Fault`), else null. */
  fault: TraceFault | null = null;
  /** The failure's frames, business logic first (see {@link TraceFrames}). */
  faultFrames: TraceFrames | null = null;
  /** Span that was innermost-open when the failure was recorded, else null. */
  faultSpanId: number | null = null;
  finalized = false;

  /** Root span (the request itself), created at begin. */
  readonly root: Span;
  /** Injecteable span-id source (defaults to the process-wide counter). */
  private readonly spanIds: SpanIdSource;
  private readonly spansById = new Map<number, Span>();
  private readonly stack: Span[] = [];
  private pendingBody: Promise<string> | null = null;
  private readonly stages = new Set<string>();
  /** Lifecycle stage rows already recorded (idempotence guard). */
  private readonly recordedStages = new Set<string>();

  constructor(ctx: IgnexContext, captureBody: boolean, spanIds: SpanIdSource = defaultSpanIds) {
    this.spanIds = spanIds;
    this.id = ctx.requestId;
    // Monotonic clock for ALL span/duration math; the wall-clock twin below
    // is only for serialization (`ts`), persistence and display.
    this.startedAtMs = performance.now();
    this.startedAtEpochMs = Date.now();
    this.method = ctx.method;
    this.path = ctx.path;
    this.route = ctx.route;
    this.requestId = ctx.requestId;
    this.ip = ctx.ip;
    // Headers are kept RAW internally so request replay is faithful (auth
    // tokens survive); redaction happens only when the trace is serialized for
    // the dashboard (see `redactRequestTrace`).
    const rawHeaders: Record<string, string> = Object.create(null) as Record<string, string>;
    ctx.headers.forEach((value, key) => {
      rawHeaders[key] = value;
    });
    this.request = {
      method: ctx.method,
      url: ctx.req.url,
      headers: rawHeaders,
      body: null,
    };
    this.root = {
      id: 0,
      parentId: null,
      name: `${ctx.method} ${ctx.path}`,
      kind: "request",
      startMs: 0,
      durationMs: 0,
      open: true,
      attrs: { route: ctx.route || undefined },
      error: null,
      origin: null,
    };
    this.spansById.set(0, this.root);
    this.stack.push(this.root);

    if (captureBody) {
      try {
        const clone = ctx.req.clone();
        this.pendingBody = clone.text().catch(() => "");
      } catch {
        this.pendingBody = null; // body already consumed or non-cloneable
      }
    }
  }

  /** Mark a lifecycle stage as observed (drives the stages list in the UI). */
  observeStage(name: string): void {
    this.stages.add(name);
  }

  get stageNames(): string[] {
    return [...this.stages];
  }

  /**
   * Record a lifecycle stage as a waterfall row. Used for the stage that
   * CREATES the trace (the `request` stage — the debugbar plugin's onRequest
   * runs inside it), so it can only be recorded once the stage has finished.
   * The row starts at the trace start (the stage began at — or a few
   * microseconds before — trace creation) and ends now, so it covers the whole
   * stage. Idempotent per stage name; `startMs` defaults to the trace start.
   */
  recordStage(name: string, startMs = 0): void {
    if (this.recordedStages.has(name)) return;
    this.recordedStages.add(name);
    const span: Span = {
      id: this.spanIds(),
      parentId: this.root.id,
      name,
      kind: "lifecycle",
      startMs: Math.max(0, startMs),
      durationMs: 0,
      open: true,
      attrs: null,
      error: null,
      origin: null,
    };
    this.spansById.set(span.id, span);
    this.end(span);
  }

  /**
   * Start a child span. Parent is the innermost still-open span (the active
   * stack), so sequential nesting is exact; concurrent siblings may nest
   * cosmetically (durations are always exact).
   *
   * Origin capture is skipped for framework lifecycle spans: their creator is
   * always the generated pipeline (a minified internal frame of no diagnostic
   * value), and capturing cost `new Error()` + stack parse PER STAGE — the
   * dominant tracer CPU cost under load (~7% of total server CPU measured on
   * a mixed-route benchmark). App spans (`ctx.debug.span(...)`) keep origins.
   */
  start(name: string, kind: SpanKind = "custom", attrs?: SpanAttrs): Span {
    const parent = this.stack[this.stack.length - 1] ?? this.root;
    const span: Span = {
      id: this.spanIds(),
      parentId: parent.id,
      name,
      kind,
      startMs: performance.now() - this.startedAtMs,
      durationMs: 0,
      open: true,
      attrs: attrs && Object.keys(attrs).length > 0 ? attrs : null,
      error: null,
      origin: kind === "lifecycle" ? null : callerOrigin(),
    };
    this.spansById.set(span.id, span);
    this.stack.push(span);
    return span;
  }

  /** End a span (idempotent, stack-ordered). */
  end(span: Span, attrs?: SpanAttrs): void {
    if (!span.open) return;
    span.open = false;
    span.durationMs = Math.max(0, performance.now() - this.startedAtMs - span.startMs);
    if (attrs) span.attrs = { ...span.attrs, ...attrs };
    // Pop defensively: end the span wherever it sits in the stack, then re-add
    // the outer spans above it (concurrent endings may be out of order).
    const idx = this.stack.lastIndexOf(span);
    if (idx !== -1) {
      this.stack.splice(idx, 1);
    }
  }

  /** End a span as failed, classifying the throw so the row can badge it. */
  fail(span: Span, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.end(span, { error: message });
    span.error = message;
    if (span.fault === undefined || span.fault === null) span.fault = markOf(err);
    // Remember WHICH span failed for the request-level fault recorded later.
    if (span !== this.root && this.faultSpanId === null) this.faultSpanId = span.id;
  }

  /** Run `fn` inside a timed span of `kind`; records failures and rethrows. */
  async span<T>(
    name: string,
    kind: SpanKind,
    fn: () => T | Promise<T>,
    attrs?: SpanAttrs,
  ): Promise<T> {
    const span = this.start(name, kind, attrs);
    try {
      const result = await fn();
      this.end(span);
      return result;
    } catch (err) {
      this.fail(span, err);
      throw err;
    }
  }

  /** Instantaneous event (zero-duration span). */
  event(name: string, attrs?: SpanAttrs): void {
    const span = this.start(name, "custom", attrs);
    this.end(span);
  }

  /** Record an error against the request (also ends the innermost span as failed when open). */
  recordError(err: unknown, attrs?: SpanAttrs): void {
    const fault = traceFault(err);
    const stack = err instanceof Error ? err.stack : undefined;
    this.fault = fault;
    this.error = fault.message.length > 0 ? fault.message : fault.summary;
    if (stack) this.errorStack = captureErrorStack(stack);
    const innermost = this.stack[this.stack.length - 1];
    if (innermost && innermost !== this.root && innermost.open) {
      this.fail(innermost, err);
    }
    // The classification rides the error row, so the waterfall explains
    // itself without the reader opening the Error tab.
    this.event(`error: ${this.error}`, { ...attrs, ...faultAttrs(fault, this.errorStack) });
  }

  /** Resolve the captured body (bounded wait) — used at finalize for replay. */
  async resolvedBody(): Promise<string | null> {
    if (!this.pendingBody) return this.request.body;
    const timeout = new Promise<string>((resolve) => {
      const t = setTimeout(() => resolve(""), 250);
      t.unref?.();
    });
    const raw = await Promise.race([this.pendingBody, timeout]);
    this.pendingBody = null;
    const body = raw === "" ? "" : clipBody(raw).text;
    this.request.body = body;
    return body;
  }

  /**
   * Record the captured response body (called by the plugin's onResponse hook
   * after it has read a textual response). Empty text stores as null.
   */
  setResponseBody(text: string): void {
    if (text === "") {
      this.responseBody = null;
      this.responseBodyTruncated = false;
      return;
    }
    const clipped = clipBody(text);
    this.responseBody = clipped.text;
    this.responseBodyTruncated = clipped.truncated;
  }

  /**
   * Close the trace: fix the root duration, close any dangling open spans,
   * record status/response metadata and the error. Idempotent.
   */
  async finalize(input: {
    status: number;
    responseHeaders: Headers | null;
    error?: unknown;
    captureBody: boolean;
  }): Promise<RequestTrace> {
    if (this.finalized) return this.toJSON();
    this.finalized = true;
    this.status = input.status;
    this.responseHeaders = input.responseHeaders
      ? captureRedactedHeaders(input.responseHeaders)
      : null;
    if (input.error !== undefined && input.error !== null && this.fault === null) {
      // A failure the app never recorded itself (`ctx.debug.error`) still has to
      // reach the trace. Re-recording classifies it, marks the span that was
      // innermost-open and adds the `error:` row to the waterfall; a failure
      // that WAS recorded keeps the classification it already carries.
      this.recordError(input.error);
    }
    if (this.error !== null) {
      // Read the failure back the way an operator reads it: the failing span's
      // origin is the application call site, while the error's own stack is
      // often all dependency internals (Bun truncates async stacks there).
      this.faultFrames = summarizeFailureFrames({
        stack: this.errorStack,
        origins: failingOrigin([...this.spansById.values()], this.faultSpanId),
      });
    }
    // Close dangling spans (request cut short) as failed/open so the waterfall
    // stays truthful instead of hiding the leak. Two spans are exempt: the
    // ROOT (it is the request itself — its duration is set below; flagging it
    // showed a bogus "✕ … span left open" on every trace) and framework
    // lifecycle stage spans, which are legitimately mid-flight when the
    // debugbar finalizes inside the afterHandle stage.
    for (const span of [...this.stack].reverse()) {
      if (span.open) {
        span.open = false;
        span.durationMs = Math.max(0, performance.now() - this.startedAtMs - span.startMs);
        if (span !== this.root && !isFrameworkStageSpan(span)) {
          span.error =
            span.error ?? (this.error ? `${this.error} (span left open)` : "span left open");
        }
      }
    }
    this.root.durationMs = Math.max(0, performance.now() - this.startedAtMs);
    if (input.captureBody) await this.resolvedBody();
    return this.toJSON();
  }

  /** Serialize to the dashboard wire shape. */
  toJSON(): RequestTrace {
    const spans = [...this.spansById.values()].map((s) => ({ ...s }));
    let dbTimeMs = 0;
    let dbCount = 0;
    for (const s of spans) {
      if (s.kind !== "db") continue;
      // A db span NESTED inside another db span is fine-grained detail on an
      // already-counted operation (e.g. a driver command-monitor span under a
      // logical ORM op span). Counting both would inflate dbCount/dbTimeMs,
      // so only outermost db spans feed the aggregates.
      let parent = s.parentId === null ? undefined : this.spansById.get(s.parentId);
      let nested = false;
      while (parent !== undefined) {
        if (parent.kind === "db") {
          nested = true;
          break;
        }
        parent = parent.parentId === null ? undefined : this.spansById.get(parent.parentId);
      }
      if (nested) continue;
      if (!s.open) dbTimeMs += s.durationMs;
      dbCount += 1;
    }
    return {
      id: this.id,
      // Epoch ms — consumers (dashboard `new Date(ts)`, SQLite pruning,
      // history `since`/`until` filters) all assume wall clock. The monotonic
      // startedAtMs must never leak onto the wire.
      ts: this.startedAtEpochMs,
      startedAtMs: this.startedAtEpochMs,
      durationMs: Math.max(0, performance.now() - this.startedAtMs),
      method: this.method,
      path: this.path,
      route: this.route,
      status: this.status,
      requestId: this.requestId,
      ip: this.ip,
      error: this.error,
      errorStack: this.errorStack,
      fault: this.fault,
      faultSpanId: this.faultSpanId,
      faultFrames: this.faultFrames,
      request: { ...this.request },
      responseHeaders: this.responseHeaders,
      responseBody: this.responseBody,
      responseBodyTruncated: this.responseBodyTruncated,
      spans,
      dbTimeMs,
      dbCount,
      stages: this.stageNames,
    };
  }
}

// ============================================================================
// Free-standing helpers (ALS-propagated; no-op without an active trace)
// ============================================================================

/** Redact sensitive headers in a serialized trace for the dashboard wire. */
export const redactRequestTrace = (trace: RequestTrace): RequestTrace => {
  const requestHeaders: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(trace.request.headers)) {
    requestHeaders[key] = isRedactedHeader(key) ? "[redacted]" : value;
  }
  const responseHeaders = trace.responseHeaders
    ? Object.fromEntries(
        Object.entries(trace.responseHeaders).map(([key, value]) => [
          key,
          isRedactedHeader(key) ? "[redacted]" : value,
        ]),
      )
    : null;
  return { ...trace, request: { ...trace.request, headers: requestHeaders }, responseHeaders };
};

/** Create a Trace from a context (used by the debugbar plugin). */
export const beginTrace = (ctx: IgnexContext, captureBody: boolean): Trace =>
  new Trace(ctx, captureBody);
