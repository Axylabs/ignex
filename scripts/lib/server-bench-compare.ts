/**
 * @fileoverview Pure comparison logic for the compiled-server regression gate.
 *
 * Kept free of filesystem/process side effects so it can be reused by
 * `scripts/check-server-bench.ts` and exercised deterministically by its
 * `--self-test` mode. The report shape mirrors the subset of
 * `bench/results/server/*.json` the gate reads.
 */

/** Per-route benchmark result for one server mode. */
export interface ServerBenchRouteResult {
  label: string;
  rps: number;
}

/** Aggregated result for one server mode (`native` / `fallback` / `raw-bun`). */
export interface ServerBenchModeResult {
  mode: string;
  routes: ServerBenchRouteResult[];
}

/**
 * The subset of a `bench/results/server/*.json` report the regression gate
 * compares. Other fields (`generatedAt`, `bun`, `comparison`, …) are ignored.
 */
export interface ServerBenchReport {
  durationSec: number;
  warmupSec: number;
  concurrency: number;
  repeats: number;
  modes: ServerBenchModeResult[];
}

/** Allowed regressions as fractions (`0.10` = 10%). */
export interface ServerBenchThresholds {
  /** Max native req/s drop vs the committed baseline. */
  rps: number;
  /** Max native req/s drop vs the fallback run in the same report. */
  fallback: number;
}

/** Default thresholds used by `check-server-bench.ts`. */
export const DEFAULT_SERVER_BENCH_THRESHOLDS: ServerBenchThresholds = {
  rps: 0.1,
  fallback: 0.15,
};

/** Result of comparing a `latest` run against a `baseline` run. */
export interface ServerBenchComparison {
  /** Human-readable failure lines (empty = pass). */
  failures: string[];
  /** Whether the run parameters match, so baseline-relative rps is comparable. */
  paramsMatch: boolean;
}

/**
 * Map route label → rps for one mode. A missing mode (or route) is simply
 * absent from the map, which the comparator treats as "no data — skip".
 *
 * @param report - Parsed server-bench report.
 * @param mode - Mode name to extract (`native`, `fallback`, …).
 * @returns Route label → req/s for that mode.
 */
export function routeRps(report: ServerBenchReport, mode: string): Map<string, number> {
  return new Map(
    (report.modes.find((m) => m.mode === mode)?.routes ?? []).map((r) => [r.label, r.rps]),
  );
}

/**
 * Compare a freshly-written `latest` report against a `baseline`.
 *
 * Two independent failure classes are detected:
 *   1. native req/s regressing more than `thresholds.rps` vs the baseline
 *      (only when the run parameters match — otherwise absolute rps is not
 *      comparable), and
 *   2. native req/s falling more than `thresholds.fallback` behind the fallback
 *      run in the SAME `latest` report (parameter-independent).
 *
 * @param latest - The newly-measured report.
 * @param baseline - The committed reference report.
 * @param thresholds - Allowed regressions; defaults to
 *   {@link DEFAULT_SERVER_BENCH_THRESHOLDS}.
 * @returns The failure lines plus whether the run parameters matched.
 */
export function compareServerReports(
  latest: ServerBenchReport,
  baseline: ServerBenchReport,
  thresholds: ServerBenchThresholds = DEFAULT_SERVER_BENCH_THRESHOLDS,
): ServerBenchComparison {
  const latestNative = routeRps(latest, "native");
  const latestFallback = routeRps(latest, "fallback");
  const baselineNative = routeRps(baseline, "native");

  // Absolute req/s is only comparable to the baseline when the run parameters
  // (duration/warmup/concurrency/repeats) match; the native-vs-fallback check
  // is parameter-independent (both modes run in the same latest.json).
  const paramsMatch =
    latest.durationSec === baseline.durationSec &&
    latest.warmupSec === baseline.warmupSec &&
    latest.concurrency === baseline.concurrency &&
    latest.repeats === baseline.repeats;

  const failures: string[] = [];

  for (const [label, nativeRps] of latestNative) {
    if (paramsMatch) {
      const base = baselineNative.get(label);
      if (base !== undefined && base > 0 && nativeRps < base * (1 - thresholds.rps)) {
        failures.push(
          `${label}: native ${nativeRps.toFixed(1)} rps regressed >${(thresholds.rps * 100).toFixed(0)}% vs baseline ${base.toFixed(1)}`,
        );
      }
    }

    const fallbackRps = latestFallback.get(label);
    if (
      fallbackRps !== undefined &&
      fallbackRps > 0 &&
      nativeRps < fallbackRps * (1 - thresholds.fallback)
    ) {
      failures.push(
        `${label}: native ${nativeRps.toFixed(1)} rps fell >${(thresholds.fallback * 100).toFixed(0)}% behind fallback ${fallbackRps.toFixed(1)}`,
      );
    }
  }

  return { failures, paramsMatch };
}
