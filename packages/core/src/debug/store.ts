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
  /**
   * Total bytes budget for captured request/response bodies across the ring.
   * When a new trace pushes the total over the budget, bodies are shed from
   * the OLDEST retained traces first (spans/timing survive — only the body
   * text is dropped), so retention stays bounded no matter how fat the
   * payloads are. Default 32 MiB.
   */
  readonly maxBodyBytes?: number;
  /**
   * Mutation notification (push/clear) — used by the debugbar's live-stream
   * revision counters; called after the mutation completes.
   */
  readonly onNotify?: () => void;
}

/** Default aggregate body budget: 32 MiB. */
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

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
/** Filter options for {@link TraceStore.summaries}. */
export interface TraceSummaryFilter {
  errorOnly?: boolean;
  limit?: number;
  /** Case-insensitive substring over `method + path + error`. */
  q?: string;
  /** Exact HTTP method (e.g. "GET"). */
  method?: string;
  /** Status family ("2xx" | "3xx" | "4xx" | "5xx"). */
  status?: string;
  /** Inclusive lower time bound (epoch ms). */
  since?: number | undefined;
  /** Inclusive upper time bound (epoch ms). */
  until?: number | undefined;
  /** Substring match against the matched route pattern. */
  route?: string;
  /** Only rows that took at least this long (ms). */
  minDurationMs?: number | undefined;
}

const statusFamily = (status: number): string => `${Math.floor(status / 100)}xx`;

/** Time/method/status/route/duration/text gate shared by the list views. */
const matchesSummaryFilter = (options: TraceSummaryFilter) => {
  const q = options.q?.trim().toLowerCase();
  const route = options.route?.trim().toLowerCase();
  const methodUpper = options.method?.toUpperCase();
  return (t: RequestTrace): boolean => {
    if (options.errorOnly && !t.error) return false;
    if (options.since !== undefined && t.ts < options.since) return false;
    if (options.until !== undefined && t.ts > options.until) return false;
    if (methodUpper && t.method.toUpperCase() !== methodUpper) return false;
    if (options.status && statusFamily(t.status) !== options.status) return false;
    if (route && t.route.toLowerCase().indexOf(route) === -1) return false;
    if (options.minDurationMs !== undefined && t.durationMs < options.minDurationMs) return false;
    if (q && `${t.method} ${t.path} ${t.error ?? ""}`.toLowerCase().indexOf(q) === -1) return false;
    return true;
  };
};

/** Approximate retained body bytes of a trace (UTF-16 units ≈ bytes). */
const bodyBytesOf = (t: RequestTrace): number =>
  (t.request.body?.length ?? 0) + (t.responseBody?.length ?? 0);

/**
 * Bounded in-memory store of finalized request traces (ring buffer + error
 * index + body budget). All accessors are synchronous so the dashboard APIs
 * serve inline.
 */
export class TraceStore {
  readonly maxTraces: number;
  readonly maxBodyBytes: number;
  private readonly traces: RequestTrace[] = [];
  private readonly errorIds = new Set<string>();
  /** Retained body bytes per trace id (for budget accounting on evict/strip). */
  private readonly bodyBytesById = new Map<string, number>();
  private bodyBytesTotal = 0;

  private readonly onNotify: (() => void) | null;

  constructor(options: TraceStoreOptions = {}) {
    this.maxTraces = options.maxTraces ?? 500;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.onNotify = options.onNotify ?? null;
  }

  /**
   * Shed the captured bodies of a stored trace (keep spans/timing/metadata).
   * @returns The bytes freed. Idempotent.
   */
  private stripBodies(trace: RequestTrace): number {
    const had = this.bodyBytesById.get(trace.id) ?? 0;
    if (had === 0) return 0;
    if (trace.request.body !== null) trace.request.body = null;
    trace.responseBody = null;
    trace.responseBodyTruncated = false;
    this.bodyBytesById.delete(trace.id);
    this.bodyBytesTotal -= had;
    return had;
  }

  /** Insert a finalized trace (drops the oldest when full; enforces the body budget). */
  push(trace: RequestTrace): void {
    this.traces.push(trace);
    const bytes = bodyBytesOf(trace);
    if (bytes > 0) {
      this.bodyBytesById.set(trace.id, bytes);
      this.bodyBytesTotal += bytes;
    }
    if (trace.error) this.errorIds.add(trace.id);
    while (this.traces.length > this.maxTraces) {
      const dropped = this.traces.shift();
      if (!dropped) break;
      if (dropped.error) this.errorIds.delete(dropped.id);
      this.stripBodies(dropped);
    }
    // Body budget: shed the OLDEST captures' bodies until under budget. The
    // newest trace is never stripped by its own push — it just arrived and is
    // the one the developer is most likely to open.
    if (this.bodyBytesTotal > this.maxBodyBytes) {
      for (const t of this.traces) {
        if (this.bodyBytesTotal <= this.maxBodyBytes) break;
        if (t === trace) continue;
        this.stripBodies(t);
      }
    }
    this.onNotify?.();
  }

  /** All retained traces, newest first. */
  list(): RequestTrace[] {
    return [...this.traces].reverse();
  }

  /** Compact rows (newest first) with optional filters. */
  summaries(options: TraceSummaryFilter = {}): TraceSummary[] {
    const limit = options.limit ?? 100;
    const matches = matchesSummaryFilter(options);
    const rows: TraceSummary[] = [];
    for (let i = this.traces.length - 1; i >= 0 && rows.length < limit; i--) {
      const t = this.traces[i];
      if (t === undefined || !matches(t)) continue;
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
      const t = this.traces[i];
      if (t === undefined) continue;
      if (t.error) out.push(t);
    }
    return out;
  }

  /** Drop everything. */
  clear(): void {
    this.traces.length = 0;
    this.errorIds.clear();
    this.bodyBytesById.clear();
    this.bodyBytesTotal = 0;
    this.onNotify?.();
  }

  get size(): number {
    return this.traces.length;
  }

  get errorCount(): number {
    return this.errorIds.size;
  }

  /** Total bytes of request/response bodies currently retained. */
  get retainedBodyBytes(): number {
    return this.bodyBytesTotal;
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
