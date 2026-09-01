/**
 * @fileoverview MetricsRegistry — counters, gauges and route histograms.
 *
 * The registry aggregates one histogram per route pattern (`GET /users/:id`),
 * status-family totals, app-defined counters and system gauges (RSS/heap/
 * event-loop/active requests, updated by the profiler's sample hook). It
 * exposes two shapes:
 *
 * - {@link MetricsRegistry.snapshot} — the JSON document for the dashboard
 *   and MCP (`GET {path}/api/metrics`).
 * - {@link MetricsRegistry.prometheus} — the Prometheus text exposition
 *   format (`GET {path}/api/metrics/prometheus`) so any Prometheus scraper
 *   (and therefore Grafana) can pull live ignex metrics with zero agents.
 */

import type {
  HistogramSnapshot,
  MetricsSnapshot,
  RouteMetrics,
  SpanAttrs,
  SystemSample,
} from "./types";

/** Options for {@link MetricsRegistry}. */
export interface MetricsRegistryOptions {
  /** Maximum distinct routes tracked (guards cardinality). Default 500. */
  readonly maxRoutes?: number;
  /**
   * Duration histogram bucket upper bounds in ms (ascending). Default covers
   * 1 ms → 10 s in Prometheus-class spacing.
   */
  readonly durationBucketsMs?: number[];
}

/** Default duration buckets (ms) — tight near the p50s, roomy at the tail. */
export const DEFAULT_DURATION_BUCKETS_MS: readonly number[] = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
];

/** Fixed-bucket histogram (Prometheus semantics). */
class Histogram {
  readonly bounds: readonly number[];
  /** Per-bucket observation counts (NOT cumulative — see {@link cumulative}). */
  readonly counts: number[];
  overflow = 0;
  sum = 0;
  count = 0;

  constructor(bounds: readonly number[]) {
    this.bounds = bounds;
    this.counts = Array.from({ length: bounds.length }, () => 0);
  }

  /** Record one observation (value unit = whatever the buckets are in). */
  observe(value: number): void {
    this.sum += value;
    this.count++;
    for (let i = 0; i < this.bounds.length; i++) {
      if (value <= (this.bounds[i] ?? Infinity)) {
        this.counts[i] = (this.counts[i] ?? 0) + 1;
        return;
      }
    }
    this.overflow++;
  }

  /**
   * Cumulative counts per bound (bucket le=b includes every value ≤ b),
   * as required by the Prometheus exposition format.
   */
  cumulative(): number[] {
    const out: number[] = [];
    let total = 0;
    for (const c of this.counts) {
      total += c ?? 0;
      out.push(total);
    }
    return out;
  }

  /**
   * Estimate a quantile from the cumulative counts (linear interpolation
   * inside the bucket that first reaches `q*count`). Returns 0 when empty.
   */
  quantile(q: number): number {
    if (this.count === 0) return 0;
    const target = Math.max(1, Math.ceil(q * this.count));
    const cums = this.cumulative();
    let prevBound = 0;
    let prevCum = 0;
    for (let i = 0; i < this.bounds.length; i++) {
      const bound = this.bounds[i] ?? prevBound;
      const cum = cums[i] ?? prevCum;
      if (cum >= target) {
        const span = Math.max(cum - prevCum, 1);
        const pos = (target - prevCum) / span;
        return prevBound + (bound - prevBound) * pos;
      }
      prevBound = bound;
      prevCum = cum;
    }
    // Above the last finite bucket: report the highest observed boundary.
    return this.overflow > 0 ? (this.bounds[this.bounds.length - 1] ?? 0) : 0;
  }

  snapshot(): HistogramSnapshot {
    return {
      bounds: [...this.bounds],
      counts: this.cumulative(),
      overflow: this.overflow,
      sum: this.sum,
      count: this.count,
    };
  }
}

interface RouteStats {
  key: string;
  requests: number;
  errors: number;
  statuses: { s2xx: number; s3xx: number; s4xx: number; s5xx: number };
  duration: Histogram;
  dbQueries: number;
  dbMs: number;
  lastStatus: number;
  lastTs: number;
}

/** Escape a Prometheus label value (`\`, `"`, newline). */
const escapeLabel = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/**
 * Aggregate HTTP + system metrics for the observatory. Cheap to feed (one
 * histogram observe per finalized request), safe to read concurrently.
 */
export class MetricsRegistry {
  readonly maxRoutes: number;
  readonly durationBucketsMs: readonly number[];
  private readonly routes = new Map<string, RouteStats>();
  private readonly gauges = new Map<string, number>();
  private readonly counters = new Map<string, { labels: SpanAttrs; value: number }>();
  private startedAt = Date.now();

  constructor(options: MetricsRegistryOptions = {}) {
    this.maxRoutes = options.maxRoutes ?? 500;
    this.durationBucketsMs = options.durationBucketsMs ?? DEFAULT_DURATION_BUCKETS_MS;
  }

  /** Reset all series and restart the uptime clock (tests / manual reset). */
  reset(): void {
    this.routes.clear();
    this.gauges.clear();
    this.counters.clear();
    this.startedAt = Date.now();
  }

  /**
   * Observe one finalized request. `routeKey` is the matched route pattern
   * including method (e.g. `"GET /users/:id"`); unmatched requests fall back
   * to the raw path so nothing disappears.
   */
  observeRequest(input: {
    method: string;
    routeKey: string;
    status: number;
    durationMs: number;
    error?: boolean;
    dbQueries?: number;
    dbMs?: number;
  }): void {
    const family =
      input.status >= 500
        ? "s5xx"
        : input.status >= 400
          ? "s4xx"
          : input.status >= 300
            ? "s3xx"
            : "s2xx";
    let stats = this.routes.get(input.routeKey);
    if (!stats) {
      if (this.routes.size >= this.maxRoutes) return; // cardinality guard
      stats = {
        key: input.routeKey,
        requests: 0,
        errors: 0,
        statuses: { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 },
        duration: new Histogram(this.durationBucketsMs),
        dbQueries: 0,
        dbMs: 0,
        lastStatus: 0,
        lastTs: 0,
      };
      this.routes.set(input.routeKey, stats);
    }
    stats.requests++;
    stats.statuses[family]++;
    if (input.error || family === "s4xx" || family === "s5xx") stats.errors++;
    stats.duration.observe(Math.max(0, input.durationMs));
    stats.dbQueries += input.dbQueries ?? 0;
    stats.dbMs += input.dbMs ?? 0;
    stats.lastStatus = input.status;
    stats.lastTs = Date.now();
  }

  /** Set a named gauge to an absolute value (later overwritten, never summed). */
  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /** Apply one profiler sample to the standard system gauges. */
  observeSystem(sample: SystemSample): void {
    this.gauge("process_rss_mib", sample.rssMiB);
    this.gauge("process_heap_used_mib", sample.heapMiB);
    this.gauge("event_loop_delay_ms", sample.eventLoopDelayMs);
    this.gauge("active_requests", sample.activeRequests);
    this.gauge("process_cpu_pct", sample.cpuPct);
  }

  /**
   * Increment a named counter, optionally labeled. Same name + equivalent
   * label sets share one series.
   */
  incCounter(name: string, labels?: SpanAttrs, by = 1): void {
    const key = `${name}\u0000${JSON.stringify(labels ?? {})}`;
    const entry = this.counters.get(key);
    if (entry) entry.value += by;
    else this.counters.set(key, { labels: labels ?? {}, value: by });
  }

  /** Per-route aggregates, busiest first. */
  routeRows(): RouteMetrics[] {
    const rows: RouteMetrics[] = [];
    for (const stats of this.routes.values()) {
      rows.push({
        key: stats.key,
        requests: stats.requests,
        errors: stats.errors,
        totalMs: Math.round(stats.duration.sum * 100) / 100,
        p50Ms: Math.round(stats.duration.quantile(0.5) * 100) / 100,
        p95Ms: Math.round(stats.duration.quantile(0.95) * 100) / 100,
        p99Ms: Math.round(stats.duration.quantile(0.99) * 100) / 100,
        dbQueries: stats.dbQueries,
        dbMs: Math.round(stats.dbMs * 100) / 100,
        lastStatus: stats.lastStatus,
        lastTs: stats.lastTs,
      });
    }
    return rows.sort((a, b) => b.requests - a.requests || b.totalMs - a.totalMs);
  }

  /** JSON snapshot for `/api/metrics` (dashboard + MCP consumers). */
  snapshot(): MetricsSnapshot {
    let requests = 0;
    let errors = 0;
    let dbQueries = 0;
    const families = { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 };
    for (const r of this.routes.values()) {
      requests += r.requests;
      errors += r.errors;
      dbQueries += r.dbQueries;
      families.s2xx += r.statuses.s2xx;
      families.s3xx += r.statuses.s3xx;
      families.s4xx += r.statuses.s4xx;
      families.s5xx += r.statuses.s5xx;
    }
    return {
      startedAt: this.startedAt,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      totals: {
        requests,
        errors,
        status2xx: families.s2xx,
        status3xx: families.s3xx,
        status4xx: families.s4xx,
        status5xx: families.s5xx,
        dbQueries,
      },
      gauges: Object.fromEntries(this.gauges),
      counters: [...this.counters.entries()].map(([key, c]) => ({
        name: key.split("\u0000")[0] ?? "",
        labels: c.labels,
        value: c.value,
      })),
      routes: this.routeRows(),
      durationBucketsMs: [...this.durationBucketsMs],
    };
  }

  /**
   * Prometheus text exposition (content type
   * `text/plain; version=0.0.4`). Deterministic ordering: route series sorted
   * by key, then buckets ascending, so scrapes diff cleanly.
   */
  prometheus(): string {
    const lines: string[] = [];
    const keys = [...this.routes.keys()].sort();
    const route = (key: string): RouteStats =>
      this.routes.get(key) ?? {
        key,
        requests: 0,
        errors: 0,
        statuses: { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 },
        duration: new Histogram(this.durationBucketsMs),
        dbQueries: 0,
        dbMs: 0,
        lastStatus: 0,
        lastTs: 0,
      };

    lines.push("# TYPE ignex_http_requests_total counter");
    for (const key of keys) {
      lines.push(`ignex_http_requests_total{route="${escapeLabel(key)}"} ${route(key).requests}`);
    }
    lines.push("# TYPE ignex_http_requests_errors_total counter");
    for (const key of keys) {
      lines.push(
        `ignex_http_requests_errors_total{route="${escapeLabel(key)}"} ${route(key).errors}`,
      );
    }

    lines.push("# TYPE ignex_http_request_duration_ms histogram");
    for (const key of keys) {
      const h = route(key).duration;
      const label = `route="${escapeLabel(key)}"`;
      const cums = h.cumulative();
      for (let i = 0; i < h.bounds.length; i++) {
        lines.push(
          `ignex_http_request_duration_ms_bucket{${label},le="${h.bounds[i]}"} ${cums[i] ?? 0}`,
        );
      }
      lines.push(`ignex_http_request_duration_ms_bucket{${label},le="+Inf"} ${h.count}`);
      lines.push(`ignex_http_request_duration_ms_sum{${label}} ${Math.round(h.sum * 1000) / 1000}`);
      lines.push(`ignex_http_request_duration_ms_count{${label}} ${h.count}`);
    }

    lines.push("# TYPE ignex_db_queries_total counter");
    for (const key of keys) {
      lines.push(`ignex_db_queries_total{route="${escapeLabel(key)}"} ${route(key).dbQueries}`);
    }

    lines.push("# TYPE ignex_process_rss_mib gauge");
    lines.push(`ignex_process_rss_mib ${this.gauges.get("process_rss_mib") ?? 0}`);
    lines.push("# TYPE ignex_process_heap_used_mib gauge");
    lines.push(`ignex_process_heap_used_mib ${this.gauges.get("process_heap_used_mib") ?? 0}`);
    lines.push("# TYPE ignex_process_cpu_pct gauge");
    lines.push(`ignex_process_cpu_pct ${this.gauges.get("process_cpu_pct") ?? 0}`);
    lines.push("# TYPE ignex_event_loop_delay_ms gauge");
    lines.push(`ignex_event_loop_delay_ms ${this.gauges.get("event_loop_delay_ms") ?? 0}`);
    lines.push("# TYPE ignex_active_requests gauge");
    lines.push(`ignex_active_requests ${this.gauges.get("active_requests") ?? 0}`);

    if (this.counters.size > 0) {
      lines.push("# TYPE ignex_counter counter");
      for (const [key, entry] of this.counters) {
        const name = key.split("\u0000")[0] ?? "";
        const labelPairs = Object.entries(entry.labels)
          .map(([k, v]) => `${k}="${escapeLabel(String(v))}"`)
          .join(",");
        lines.push(
          `ignex_counter{name="${escapeLabel(name)}"${labelPairs ? `,${labelPairs}` : ""}} ${entry.value}`,
        );
      }
    }

    return `${lines.join("\n")}\n`;
  }
}
