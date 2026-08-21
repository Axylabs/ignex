/**
 * @fileoverview `createMetrics` — a small Prometheus-style metrics registry.
 *
 * Counters + histograms with bounded per-route labels, rendered in the
 * Prometheus text exposition format (and consumed by an optional OTLP push).
 * This is DX over the standard protocol, not a new monitoring system: the
 * registry is tiny and dependency-free; `/metrics` is served by the
 * `metricsPlugin`; an OTLP exporter can be added on top.
 *
 * ```ts
 * import { createMetrics } from "@ignex/core";
 * const m = createMetrics();
 * m.counter("http_requests_total", { route: "/health" }).inc();
 * m.histogram("http_request_duration_ms", { route: "/health" }).observe(12.3);
 * console.log(m.renderPrometheus());  // Prometheus text format
 * ```
 */

/** A labeled counter. */
export interface Counter {
  inc(by?: number): void;
  readonly value: number;
}

/** A labeled histogram (fixed buckets, ms-friendly). */
export interface Histogram {
  observe(value: number): void;
  readonly count: number;
  readonly sum: number;
  readonly buckets: ReadonlyArray<{ le: number; count: number }>;
}

/** Metrics options. */
export interface MetricsOptions {
  /** Histogram bucket upper-bounds (ms). Default spans 1ms → 10s. */
  histogramBuckets?: readonly number[];
}

/** The metrics registry. */
export interface Metrics {
  /** Increment a labeled counter (creates the series on first use). */
  counter(name: string, labels?: Record<string, string>): Counter;
  /** Observe a value into a labeled histogram (creates the series on first use). */
  histogram(name: string, labels?: Record<string, string>): Histogram;
  /** Render every series in Prometheus text format. */
  renderPrometheus(): string;
  /** Snapshot for exporters (counters + histograms with labels). */
  snapshot(): MetricsSnapshot;
}

/** A snapshot series for exporters. */
export interface MetricsSnapshot {
  counters: Array<{ name: string; labels: Record<string, string>; value: number }>;
  histograms: Array<{
    name: string;
    labels: Record<string, string>;
    count: number;
    sum: number;
    buckets: Array<{ le: number; count: number }>;
  }>;
}

/** Default histogram buckets in ms (1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000). */
const DEFAULT_BUCKETS = [1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

const labelKey = (labels: Record<string, string>): string =>
  Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(",");

const escapeLabel = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Create a metrics registry. */
export const createMetrics = (options: MetricsOptions = {}): Metrics => {
  const buckets = [...(options.histogramBuckets ?? DEFAULT_BUCKETS)];
  const counters = new Map<
    string,
    { name: string; labels: Record<string, string>; value: number }
  >();
  const histograms = new Map<
    string,
    {
      name: string;
      labels: Record<string, string>;
      count: number;
      sum: number;
      bucketCounts: number[];
    }
  >();

  return {
    counter(name, labels = {}) {
      const key = `${name}{${labelKey(labels)}}`;
      let entry = counters.get(key);
      if (!entry) {
        entry = { name, labels: { ...labels }, value: 0 };
        counters.set(key, entry);
      }
      return {
        inc(by = 1) {
          entry.value += by;
        },
        get value() {
          return entry.value;
        },
      };
    },

    histogram(name, labels = {}) {
      const key = `${name}{${labelKey(labels)}}`;
      let entry = histograms.get(key);
      if (!entry) {
        entry = {
          name,
          labels: { ...labels },
          count: 0,
          sum: 0,
          bucketCounts: buckets.map(() => 0),
        };
        histograms.set(key, entry);
      }
      return {
        observe(value) {
          entry.count += 1;
          entry.sum += value;
          for (let i = 0; i < buckets.length; i++) {
            if (value <= (buckets[i] ?? Infinity)) {
              entry.bucketCounts[i] = (entry.bucketCounts[i] ?? 0) + 1;
            }
          }
        },
        get count() {
          return entry.count;
        },
        get sum() {
          return entry.sum;
        },
        get buckets() {
          return buckets.map((le, i) => ({ le, count: entry.bucketCounts[i] ?? 0 }));
        },
      };
    },

    renderPrometheus() {
      const lines: string[] = [];
      for (const [key, entry] of counters) {
        const labels = labelKey(entry.labels);
        lines.push(`${key} ${entry.value}`);
        void labels;
      }
      for (const [key, entry] of histograms) {
        const base = key.slice(0, key.indexOf("{")) || key;
        const labels = entry.labels;
        for (let i = 0; i < buckets.length; i++) {
          const le = buckets[i];
          const count = entry.bucketCounts[i] ?? 0;
          lines.push(`${base}_bucket{${labelKey({ ...labels, le: String(le) })}} ${count}`);
        }
        lines.push(`${base}_bucket{${labelKey({ ...labels, le: "+Inf" })}} ${entry.count}`);
        lines.push(`${base}_sum{${labelKey(labels)}} ${entry.sum}`);
        lines.push(`${base}_count{${labelKey(labels)}} ${entry.count}`);
      }
      return lines.join("\n") + (lines.length > 0 ? "\n" : "");
    },

    snapshot() {
      return {
        counters: [...counters.values()].map((c) => ({
          name: c.name,
          labels: c.labels,
          value: c.value,
        })),
        histograms: [...histograms.values()].map((h) => ({
          name: h.name,
          labels: h.labels,
          count: h.count,
          sum: h.sum,
          buckets: buckets.map((le, i) => ({ le, count: h.bucketCounts[i] ?? 0 })),
        })),
      };
    },
  };
};
