/**
 * @fileoverview Debug helper API — the free-function tracing surface.
 *
 * The `debugSpan` / `debugQuery` / `debugEvent` / `debugError` / `debugCache`
 * free functions record against the ALS-propagated trace of the current
 * request (no-op pass-throughs when no trace is active), and
 * `NOOP_DEBUG_API` / `createDebugApi` build the `ctx.debug` surface. Split
 * from `./tracer` (the `Trace` engine) so consumers of the helper API don't
 * drag in the span-tree machinery.
 */

import { debugLog } from "./logs";
import { currentTrace, type Trace } from "./tracer";
import type { DebugApi, DebugSpanHandle, LogLevel, SpanAttrs, SpanKind } from "./types";

/** Preview cap for captured query results (kept small: spans live in a ring). */
const QUERY_PREVIEW_CHARS = 2048;

/**
 * Summarize a query result for the span attrs — enough to see WHAT came back
 * (row count, mutation count, shape preview) without storing whole payloads
 * in the trace ring. Arrays count as rows; bun:sqlite results expose
 * `changes`/`lastInsertRowid`; everything else falls back to a JSON preview.
 */
export const summarizeQueryResult = (result: unknown): SpanAttrs | null => {
  if (result === undefined) return null;
  const meta: SpanAttrs = {};
  if (Array.isArray(result)) {
    meta.rowCount = result.length;
  } else if (result !== null && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.changes === "number") meta.changes = r.changes;
    if (Array.isArray(r.rows)) meta.rowCount = r.rows.length;
    else if (typeof r.length === "number" && !r.rows) meta.rowCount = r.length;
    if (r.lastInsertRowid !== undefined && r.lastInsertRowid !== null) {
      meta.lastInsertRowid = r.lastInsertRowid;
    }
  } else if (typeof result === "number" || typeof result === "boolean") {
    meta.value = result;
    return meta;
  }
  let preview: string;
  try {
    preview = JSON.stringify(result) ?? String(result);
  } catch {
    preview = String(result);
  }
  meta.preview =
    preview.length > QUERY_PREVIEW_CHARS ? `${preview.slice(0, QUERY_PREVIEW_CHARS)}…` : preview;
  return meta;
};

/** Run `fn` inside a timed span of the active request (no-op without one). */
export function debugSpan<T>(
  name: string,
  kind: SpanKind,
  fn: () => T | Promise<T>,
  attrs?: SpanAttrs,
): T | Promise<T> {
  const trace = currentTrace();
  // Sync passthrough when no trace is active: no Promise/microtask is
  // allocated for untraced requests (the common production case).
  if (!trace) return fn();
  return trace.span(name, kind, fn, attrs);
}

/** True when `params` carries capturable content (not undefined/null/empty). */
const hasParams = (params: unknown): boolean =>
  params !== undefined &&
  params !== null &&
  !(Array.isArray(params) && params.length === 0) &&
  !(typeof params === "object" && Object.keys(params as object).length === 0);

/** Time a DB query against the active request; returns its result. */
export function debugQuery<T>(
  sql: string,
  params: unknown,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const trace = currentTrace();
  if (!trace) return fn();
  // `params` is whatever the caller wants recorded as WHAT WAS SENT: positional
  // SQL binds (array), a Mongo filter/options document (object), anything
  // JSON-safe. Stored verbatim under the span's `params` attr.
  const span = trace.start(sql, "db", hasParams(params) ? { params } : undefined);
  const settle = (value: unknown): T => {
    trace.end(span, summarizeQueryResult(value) ?? undefined);
    return value as T;
  };
  const result = fn();
  if (result instanceof Promise) {
    return result.then(settle, (err) => {
      trace.fail(span, err);
      throw err;
    });
  }
  return settle(result);
}

/** Attach an instantaneous event/note to the active request (no-op without one). */
export function debugEvent(name: string, attrs?: SpanAttrs): void {
  const trace = currentTrace();
  if (!trace) return;
  trace.event(name, attrs);
}

/** Record an error against the active request (no-op without one). */
export function debugError(err: unknown, attrs?: SpanAttrs): void {
  const trace = currentTrace();
  if (!trace) return;
  trace.recordError(err, attrs);
}

/** Record a cache operation against the active request. */
export function debugCache(
  hit: boolean,
  label: string,
  durationMs?: number,
  attrs?: SpanAttrs,
): void {
  const trace = currentTrace();
  if (!trace) return;
  const span = trace.start(label, "cache", {
    hit,
    ...(durationMs !== undefined ? { ms: durationMs } : {}),
    ...attrs,
  });
  // ALWAYS end: a cache record is instantaneous bookkeeping — leaving it open
  // dangles until finalize, which flags every such span "span left open" (a
  // false error row on the waterfall). The caller-measured duration (when
  // provided) replaces the ~0ms measured here.
  trace.end(span);
  if (durationMs !== undefined && Number.isFinite(durationMs)) {
    span.durationMs = Math.max(0, durationMs);
  }
}

// ============================================================================
// Per-request DebugApi built on a Trace
// ============================================================================

/**
 * Shared no-op {@link DebugApi} — the default value of `ctx.debug` when the
 * `debugbar()` plugin is not registered (or debug mode is off). Calling spans
 * still executes `fn` correctly; nothing is recorded. Frozen and allocated
 * once, so the default costs a single reference per context.
 *
 * The pass-throughs are deliberately NOT `async`: an async fn would allocate
 * a Promise + microtask per call even when doing nothing. Routes that call
 * `ctx.debug.span(...)` unconditionally (the documented pattern) then stay
 * promise-free in production when `fn` itself is synchronous. The declared
 * `Promise<T>` return stays honest for the REAL tracing implementation
 * ({@link createDebugApi}); the no-op's plain passthrough is assignable to
 * any `await`-consumed position, which is the documented usage.
 */
export const NOOP_DEBUG_API: DebugApi = Object.freeze({
  span<T>(_name: string, _kind: SpanKind, fn: () => T | Promise<T>): Promise<T> {
    return fn() as Promise<T>;
  },
  start(_name: string, _kind: SpanKind = "custom"): DebugSpanHandle {
    return {
      name: _name,
      kind: _kind,
      end() {},
      endWithError() {},
    };
  },
  query(_sql: string, _params: unknown, fn?: () => unknown | Promise<unknown>): Promise<unknown> {
    return fn?.() as Promise<unknown>;
  },
  cache() {},
  http(_label: string, fn: () => Response | Promise<Response>): Promise<Response> {
    return fn() as Promise<Response>;
  },
  event() {},
  error() {},
  log(level: LogLevel, message: string, attrs?: SpanAttrs) {
    debugLog(level, message, attrs);
  },
});

/** Build the `ctx.debug` API bound to a trace. */
export const createDebugApi = (trace: Trace): DebugApi => ({
  async span<T>(
    name: string,
    kind: SpanKind,
    fn: () => T | Promise<T>,
    attrs?: SpanAttrs,
  ): Promise<T> {
    return trace.span(name, kind, fn, attrs);
  },
  start(name: string, kind: SpanKind = "custom", attrs?: SpanAttrs): DebugSpanHandle {
    const span = trace.start(name, kind, attrs);
    return {
      name,
      kind,
      end(attrs2?: SpanAttrs) {
        trace.end(span, attrs2);
      },
      endWithError(err: unknown) {
        trace.fail(span, err);
      },
    };
  },
  async query(sql, params, fn) {
    const span = trace.start(sql, "db", hasParams(params) ? { params } : undefined);
    try {
      const result = await fn?.();
      trace.end(span, summarizeQueryResult(result) ?? undefined);
      return result;
    } catch (err) {
      trace.fail(span, err);
      throw err;
    }
  },
  cache(hit, label, durationMs, attrs) {
    const span = trace.start(label, "cache", {
      hit,
      ...(durationMs !== undefined ? { ms: durationMs } : {}),
      ...attrs,
    });
    // Always close (see debugCache); honor the caller-measured duration.
    trace.end(span);
    if (durationMs !== undefined && Number.isFinite(durationMs)) {
      span.durationMs = Math.max(0, durationMs);
    }
  },
  async http(label, fn) {
    const span = trace.start(label, "http", {});
    try {
      const res = await fn();
      trace.end(span, { status: res.status });
      return res;
    } catch (err) {
      trace.fail(span, err);
      throw err;
    }
  },
  event(name, attrs) {
    trace.event(name, attrs);
  },
  error(err, attrs) {
    trace.recordError(err, attrs);
  },
  log(level, message, attrs) {
    debugLog(level, message, attrs);
  },
});
