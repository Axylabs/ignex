/**
 * @fileoverview Metrics registry public types — options, the counter/histogram
 * view shapes, the decoded snapshot and the registry surface consumed by
 * `@ignex/core`.
 *
 * Extracted from the pre-split `metrics.ts` (move-only); the other domain
 * files are `./decode`, `./shared`, `./registry-native` and
 * `./registry-fallback`, all re-exported by `./index`.
 */

/** Options for {@link createMetricsRegistry}. */
export interface MetricsRegistryOptions {
  /** Histogram bucket upper-bounds. Default spans 1 → 10_000 (13 buckets). */
  histogramBuckets?: readonly number[];
}

/**
 * A labeled counter view. `inc` is the hot path; `value` is a COLD read
 * (decodes a fresh snapshot) intended for tests/debug/exporters.
 */
export interface RegistryCounter {
  inc(by?: number): void;
  readonly value: number;
}

/** A labeled histogram view (cumulative buckets). Reads are cold like {@link RegistryCounter.value}. */
export interface RegistryHistogram {
  observe(value: number): void;
  readonly count: number;
  readonly sum: number;
  readonly buckets: ReadonlyArray<{ le: number; count: number }>;
}

/** Decoded snapshot series (mirrors `@ignex/core`'s `MetricsSnapshot`). */
export interface RegistrySnapshot {
  counters: Array<{ name: string; labels: Record<string, string>; value: number }>;
  histograms: Array<{
    name: string;
    labels: Record<string, string>;
    count: number;
    sum: number;
    buckets: Array<{ le: number; count: number }>;
  }>;
}

/** The registry surface consumed by `@ignex/core`. */
export interface MetricsRegistryLike {
  counter(name: string, labels?: Record<string, string>, hint?: string): RegistryCounter;
  histogram(
    name: string,
    labels?: Record<string, string>,
    buckets?: readonly number[],
    hint?: string,
  ): RegistryHistogram;
  /** Prometheus text exposition (includes `# TYPE` headers). */
  renderPrometheus(): string;
  /** Machine-readable snapshot (decoded v1 dump). */
  snapshot(): RegistrySnapshot;
  /** Free the native handle when bun:ffi-backed (no-op otherwise). */
  destroy?(): void;
}
