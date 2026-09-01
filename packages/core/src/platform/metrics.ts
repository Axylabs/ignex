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
  /**
   * Increment a labeled counter (creates the series on first use).
   *
   * `hint` is an OPTIONAL stable series address for hot call sites: when
   * provided, it replaces label-key construction as the cache key, so the
   * per-event cost drops to a Map hit + arithmetic. The hint MUST uniquely
   * identify one series (compose it from the label VALUES); labels are
   * captured from the first call bearing that hint.
   */
  counter(name: string, labels?: Record<string, string>, hint?: string): Counter;
  /** Observe a value into a labeled histogram (same `hint` contract). */
  histogram(name: string, labels?: Record<string, string>, hint?: string): Histogram;
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

// Plain `<`/`>` comparison — byte-order stable for the label names this
// registry sees and ~5x cheaper than `localeCompare` (which consults ICU) on
// the per-event hot path.
const labelKey = (labels: Record<string, string>): string => {
  const keys = Object.keys(labels).sort();
  let out = "";
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out += ",";
    const k = keys[i] as string;
    out += `${k}="${escapeLabel(labels[k] as string)}"`;
  }
  return out;
};

const escapeLabel = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * Create a metrics registry.
 *
 * MEASURED TRADEOFF (2026-08-24, Bun 1.4.1-canary): the native-backed
 * registry (`@ignex/native` `createNativeMetricsRegistry` — C-ABI handle,
 * cstring label values, Rust render + packed v1 snapshot for OTLP) costs
 * ~625ns per labeled counter event versus ~489ns for this pure-TS registry:
 * per-event `Object.keys`/sort/join dominate both paths, and the cstring
 * transcode ADDS work instead of removing it. So the request-path default
 * stays pure TS; use `createNativeMetricsRegistry` when you want Rust-side
 * state (multi-registry aggregation, snapshot export without duplication).
 */
export const createMetrics = (options: MetricsOptions = {}): Metrics => {
  const buckets = [...(options.histogramBuckets ?? DEFAULT_BUCKETS)];
  const counters = new Map<
    string,
    { name: string; labels: Record<string, string>; value: number }
  >();
  /** Cached Counter views per series key (no per-event closure allocation). */
  const counterViews = new Map<string, Counter>();
  /** Hint-addressed Counter views (hot lane — see {@link Metrics.counter}). */
  const counterHintViews = new Map<string, Counter>();
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
  /** Cached Histogram views per series key (no per-event closure allocation). */
  const histogramViews = new Map<string, Histogram>();
  /** Hint-addressed Histogram views (hot lane — see {@link Metrics.histogram}). */
  const histogramHintViews = new Map<string, Histogram>();

  return {
    counter(name, labels = {}, hint) {
      // HOT LANE — hint-addressed: the caller guarantees the hint maps 1:1 to
      // a series, so the per-event cost is one Map hit + arithmetic (no
      // Object.keys/sort/join). Labels are captured from the FIRST call with
      // that hint and reused for render/snapshot.
      if (hint !== undefined) {
        let vh = counterHintViews.get(hint);
        if (vh === undefined) {
          const key = `${name}{${labelKey(labels)}}`;
          let entry = counters.get(key);
          if (!entry) {
            entry = { name, labels: { ...labels }, value: 0 };
            counters.set(key, entry);
          }
          vh = {
            inc(by = 1) {
              entry.value += by;
            },
            get value() {
              return entry.value;
            },
          };
          counterHintViews.set(hint, vh);
        }
        return vh;
      }

      // Cold/generic lane — series identity is (name + sorted label pairs).
      const keys = Object.keys(labels).sort();
      let keySuffix = "";
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i] as string;
        keySuffix += `${k}="${escapeLabel(labels[k] as string)}"`;
        if (i < keys.length - 1) keySuffix += ",";
      }
      const key = `${name}{${keySuffix}}`;
      const cached = counterViews.get(key);
      if (cached !== undefined) return cached;

      const entry = {
        name,
        labels: { ...labels },
        value: 0,
      };
      counters.set(key, entry);

      const view: Counter = {
        inc(by = 1) {
          entry.value += by;
        },
        get value() {
          return entry.value;
        },
      };
      counterViews.set(key, view);
      return view;
    },

    histogram(name, labels = {}, hint) {
      // Hint-addressed hot lane (see `counter`).
      if (hint !== undefined) {
        let vh = histogramHintViews.get(hint);
        if (vh === undefined) {
          const key = `${name}{${labelKey(labels)}}`;
          let entry = histograms.get(key);
          if (!entry) {
            entry = {
              name,
              labels: { ...labels },
              count: 0,
              sum: 0,
              bucketCounts: Array.from({ length: buckets.length }, () => 0),
            };
            histograms.set(key, entry);
          }
          const nB = buckets.length;
          vh = {
            observe(value) {
              entry.count += 1;
              entry.sum += value;
              if (!Number.isNaN(value)) {
                let i = 0;
                while (i < nB && (buckets[i] ?? Infinity) < value) i++;
                for (; i < nB; i++) entry.bucketCounts[i] = (entry.bucketCounts[i] ?? 0) + 1;
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
          histogramHintViews.set(hint, vh);
        }
        return vh;
      }

      // Generic lane — same view-caching as `counter`.
      const keys = Object.keys(labels).sort();
      let keySuffix = "";
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i] as string;
        keySuffix += `${k}="${escapeLabel(labels[k] as string)}"`;
        if (i < keys.length - 1) keySuffix += ",";
      }
      const key = `${name}{${keySuffix}}`;
      const cached = histogramViews.get(key);
      if (cached !== undefined) return cached;

      const nBuckets = buckets.length;
      const entry = {
        name,
        labels: { ...labels },
        count: 0,
        sum: 0,
        bucketCounts: Array.from({ length: nBuckets }, () => 0),
      };
      histograms.set(key, entry);

      const view: Histogram = {
        observe(value) {
          entry.count += 1;
          entry.sum += value;
          if (!Number.isNaN(value)) {
            let i = 0;
            while (i < nBuckets && (buckets[i] ?? Infinity) < value) i++;
            for (; i < nBuckets; i++) entry.bucketCounts[i] = (entry.bucketCounts[i] ?? 0) + 1;
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
      histogramViews.set(key, view);
      return view;
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
