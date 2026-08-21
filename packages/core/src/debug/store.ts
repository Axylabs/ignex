/**
 * @fileoverview TraceStore — bounded in-memory store of request traces.
 *
 * A ring buffer (default 500) keeps the most recent traces, plus an error
 * index (traces with `error != null`) so the dashboard's errors view never
 * scans the whole buffer. All accessors are synchronous — the dashboard APIs
 * are served inline.
 */

import type { RequestTrace } from "./types";

/** Options for {@link TraceStore}. */
export interface TraceStoreOptions {
  /** Maximum number of traces retained (ring buffer). Default 500. */
  readonly maxTraces?: number;
}

/** A compact list row served to the dashboard (no spans/headers/body). */
export interface TraceSummary {
  readonly id: string;
  readonly ts: number;
  readonly durationMs: number;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly error: string | null;
  readonly dbTimeMs: number;
  readonly dbCount: number;
  readonly spanCount: number;
}

/**
 * Bounded in-memory store of finalized request traces (ring buffer + error
 * index). All accessors are synchronous so the dashboard APIs serve inline.
 */
export class TraceStore {
  readonly maxTraces: number;
  private readonly traces: RequestTrace[] = [];
  private readonly errorIds = new Set<string>();

  constructor(options: TraceStoreOptions = {}) {
    this.maxTraces = options.maxTraces ?? 500;
  }

  /** Insert a finalized trace (drops the oldest when full). */
  push(trace: RequestTrace): void {
    this.traces.push(trace);
    if (trace.error) this.errorIds.add(trace.id);
    if (this.traces.length > this.maxTraces) {
      const dropped = this.traces.shift();
      if (dropped?.error) this.errorIds.delete(dropped.id);
    }
  }

  /** All retained traces, newest first. */
  list(): RequestTrace[] {
    return [...this.traces].reverse();
  }

  /** Compact rows (newest first) with an optional filter. */
  summaries(options: { errorOnly?: boolean; limit?: number } = {}): TraceSummary[] {
    const limit = options.limit ?? 100;
    const rows: TraceSummary[] = [];
    for (let i = this.traces.length - 1; i >= 0 && rows.length < limit; i--) {
      const t = this.traces[i]!;
      if (options.errorOnly && !t.error) continue;
      rows.push({
        id: t.id,
        ts: t.ts,
        durationMs: t.durationMs,
        method: t.method,
        path: t.path,
        status: t.status,
        error: t.error,
        dbTimeMs: t.dbTimeMs,
        dbCount: t.dbCount,
        spanCount: t.spans.length,
      });
    }
    return rows;
  }

  /** Full trace by id. */
  get(id: string): RequestTrace | undefined {
    return this.traces.find((t) => t.id === id);
  }

  /** Traces that carried an error, newest first. */
  errors(options: { limit?: number } = {}): RequestTrace[] {
    const limit = options.limit ?? 100;
    const out: RequestTrace[] = [];
    for (let i = this.traces.length - 1; i >= 0 && out.length < limit; i--) {
      const t = this.traces[i]!;
      if (t.error) out.push(t);
    }
    return out;
  }

  /** Drop everything. */
  clear(): void {
    this.traces.length = 0;
    this.errorIds.clear();
  }

  get size(): number {
    return this.traces.length;
  }

  get errorCount(): number {
    return this.errorIds.size;
  }

  /** Duration percentiles over retained traces (for the system summary). */
  percentiles(): { avgMs: number; p95Ms: number } {
    if (this.traces.length === 0) return { avgMs: 0, p95Ms: 0 };
    const durations = this.traces.map((t) => t.durationMs).sort((a, b) => a - b);
    const avgMs = durations.reduce((a, b) => a + b, 0) / durations.length;
    const p95 = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] ?? 0;
    return { avgMs, p95Ms: p95 };
  }
}
