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

import { currentTrace, type Trace } from "./tracer";
import type { DebugApi, DebugSpanHandle, SpanAttrs, SpanKind } from "./types";

/** Run `fn` inside a timed span of the active request (no-op without one). */
export async function debugSpan<T>(
  name: string,
  kind: SpanKind,
  fn: () => T | Promise<T>,
  attrs?: SpanAttrs,
): Promise<T> {
  const trace = currentTrace();
  if (!trace) return fn();
  return trace.span(name, kind, fn, attrs);
}

/** Time a DB query against the active request; returns its result. */
export async function debugQuery<T>(
  sql: string,
  params: unknown[] | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  const trace = currentTrace();
  if (!trace) return fn();
  const span = trace.start(sql, "db", params && params.length > 0 ? { params } : undefined);
  try {
    const result = await fn();
    trace.end(span);
    return result;
  } catch (err) {
    trace.fail(span, err);
    throw err;
  }
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
  if (durationMs !== undefined) trace.end(span);
}

// ============================================================================
// Per-request DebugApi built on a Trace
// ============================================================================

/**
 * Shared no-op {@link DebugApi} — the default value of `ctx.debug` when the
 * `debugbar()` plugin is not registered (or debug mode is off). Calling spans
 * still executes `fn` correctly; nothing is recorded. Frozen and allocated
 * once, so the default costs a single reference per context.
 */
export const NOOP_DEBUG_API: DebugApi = Object.freeze({
  async span<T>(_name: string, _kind: SpanKind, fn: () => T | Promise<T>): Promise<T> {
    return fn();
  },
  start(_name: string, _kind: SpanKind = "custom"): DebugSpanHandle {
    return {
      name: _name,
      kind: _kind,
      end() {},
      endWithError() {},
    };
  },
  async query(
    _sql: string,
    _params: unknown[] | undefined,
    fn?: () => unknown | Promise<unknown>,
  ): Promise<unknown> {
    return fn?.();
  },
  cache() {},
  async http(_label: string, fn: () => Response | Promise<Response>): Promise<Response> {
    return fn();
  },
  event() {},
  error() {},
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
    const span = trace.start(sql, "db", params && params.length > 0 ? { params } : undefined);
    try {
      const result = await fn?.();
      trace.end(span);
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
    if (durationMs !== undefined) trace.end(span);
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
});
