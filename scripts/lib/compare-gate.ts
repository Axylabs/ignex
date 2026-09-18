/**
 * @fileoverview Pure decision logic for the Elysia-relative compare gate.
 *
 * The gate asserts the repo's core perf claim — "AOT-compiled ignus is faster
 * than Elysia on the same workload" — from the saved compare-bench reports
 * (`bench/results/compare/<server>/<scenario>.bench.json`). For every scenario
 * present in BOTH `elysia` and `ignus-aot`, the ignus-aot per-route median p50
 * must be ≤ elysia p50 × tolerance (default 1.10). Scenarios where ignus-aot is
 * expected to lose are declared in {@link KNOWN_SLOWER} with a looser tolerance.
 *
 * This module is deliberately free of filesystem/process side effects so the
 * CLI (`scripts/check-compare-gate.ts`) and its deterministic `--self-test` can
 * both call the same decision, and so the decision can be unit-tested without a
 * benchmark run.
 *
 * Two independent decision classes live here:
 *   1. {@link evaluateCompareGate} — the p50-ratio verdict per scenario.
 *   2. {@link evaluateFreshness} — the stale-evidence guard: a saved report is
 *      only trusted when its timestamp (`generatedAt`, falling back to file
 *      mtime) is newer than the producer reference time (`--since`).
 */

/** Per-route benchmark result from a compare report (only the fields read). */
export interface CompareRouteResult {
  name: string;
  p50: number;
}

/**
 * The subset of a `bench/results/compare/<server>/<scenario>.bench.json` report
 * the gate reads. Other fields (phases, workers, failure counters, …) are
 * ignored here and validated separately by `scripts/check-compare-bench.ts`.
 */
export interface CompareReport {
  server: string;
  scenario: string;
  /** ISO-8601 UTC timestamp written by the load generator (preferred clock). */
  generatedAt?: string;
  routes: CompareRouteResult[];
}

/** Tolerance configuration: a global default plus per-scenario overrides. */
export interface CompareTolerances {
  /** Multiplier applied to elysia p50 when a scenario has no override. */
  default: number;
  /** Scenario → looser multiplier for scenarios ignus-aot is expected to lose. */
  knownSlower: Record<string, number>;
}

/** Global tolerance when a scenario isn't in {@link KNOWN_SLOWER}. */
export const DEFAULT_COMPARE_TOLERANCE = 1.1;

/**
 * Scenarios where ignus-aot is expected to trail Elysia (pacing-dominated
 * error paths, or measured losses) — asserted with a looser tolerance.
 * Measured 2026-08-22 (full-duration runs): ignus-aot wins 14/16 scenarios
 * (many by 2-3×); the near-parity ones below bounce around x1.0-x1.1 across
 * runs (02-load was a 4% WIN in the original committed run) — the tolerance
 * absorbs run-to-run noise, the gate still fails on real regressions.
 */
export const KNOWN_SLOWER: Record<string, number> = {
  // Low-rate pacing-dominated scenarios (error paths / spikes).
  "06-edge-cases": 1.25,
  "04-spike": 1.2,
  "16-crud-validation-mix": 1.15,
  // Throughput scenario that sits at the boundary; was a win in the
  // original committed run — keep a small headroom.
  "02-load": 1.15,
  // Throughput scenario where ignus-aot trails ELYSIA under SATURATION.
  //
  // Measured 2026-09-14 (x1.28) on the corrected load generator. This is a
  // genuine, previously invisible gap, not noise: until the generator was
  // fixed it was client-capped at ~1,030 rps for every participant, so both
  // servers sat far below saturation and the scenario read as parity. With the
  // fix (O(1) concurrency gate + sharded generators) the same scenario runs
  // ~45k rps for elysia and ~36k for ignus-aot, i.e. ignus-aot loses ~20% of
  // its saturated throughput while staying within ~5% of elysia at low rates
  // (see the phase table in the reports). Tracking item: per-request CPU cost
  // under concurrency. Tolerance is pinned just above the measured value so a
  // further regression still fails the gate.
  "03-stress": 1.35,
};

/** Default tolerance set used by the gate. */
export const DEFAULT_COMPARE_TOLERANCES: CompareTolerances = {
  default: DEFAULT_COMPARE_TOLERANCE,
  knownSlower: KNOWN_SLOWER,
};

/**
 * Resolve the tolerance that applies to a scenario.
 *
 * @param scenario - Scenario name (e.g. `03-stress`).
 * @param tolerances - Tolerance set; defaults to {@link DEFAULT_COMPARE_TOLERANCES}.
 * @returns The per-scenario override when present, else the global default.
 */
export function compareToleranceFor(
  scenario: string,
  tolerances: CompareTolerances = DEFAULT_COMPARE_TOLERANCES,
): number {
  return tolerances.knownSlower[scenario] ?? tolerances.default;
}

/**
 * Median p50 across a report's routes (a stable single number).
 *
 * Matches the long-standing gate behaviour: the middle element of the sorted
 * p50 list, taking the upper-middle for an even count.
 *
 * @param report - Parsed compare report.
 * @returns The median p50, or `null` when the report has no routes.
 */
export function medianRouteP50(report: CompareReport): number | null {
  const values = report.routes.map((r) => r.p50).sort((a, b) => a - b);
  if (values.length === 0) return null;
  return values[Math.floor(values.length / 2)] ?? null;
}

/** One scenario's elysia + ignus-aot report pair. */
export interface CompareScenarioInput {
  scenario: string;
  elysia: CompareReport;
  aot: CompareReport;
}

/** Per-scenario verdict produced by {@link evaluateCompareGate}. */
export interface CompareCheck {
  scenario: string;
  elysiaP50: number | null;
  aotP50: number | null;
  /** `aotP50 / elysiaP50` when both are present, else `null`. */
  ratio: number | null;
  tolerance: number;
  verdict: "ok" | "slower" | "missing";
}

/** Result of evaluating every shared scenario. */
export interface CompareGateEvaluation {
  /** Per-scenario detail, in input order. */
  checks: CompareCheck[];
  /** Human-readable violation lines (empty = pass). */
  violations: string[];
}

/**
 * Evaluate the Elysia-relative p50 gate over paired reports.
 *
 * Pure: no filesystem, no process state. A scenario whose reports lack route
 * p50 data is a violation (`missing`), mirroring the CLI's old behaviour —
 * silence must never be mistaken for a pass.
 *
 * @param inputs - Elysia + ignus-aot report pairs to compare.
 * @param tolerances - Tolerance set; defaults to {@link DEFAULT_COMPARE_TOLERANCES}.
 * @returns Per-scenario checks plus the violation lines.
 */
export function evaluateCompareGate(
  inputs: ReadonlyArray<CompareScenarioInput>,
  tolerances: CompareTolerances = DEFAULT_COMPARE_TOLERANCES,
): CompareGateEvaluation {
  const checks: CompareCheck[] = [];
  const violations: string[] = [];

  for (const { scenario, elysia, aot } of inputs) {
    const tolerance = compareToleranceFor(scenario, tolerances);
    const elysiaP50 = medianRouteP50(elysia);
    const aotP50 = medianRouteP50(aot);

    if (elysiaP50 === null || aotP50 === null || elysiaP50 === 0) {
      checks.push({ scenario, elysiaP50, aotP50, ratio: null, tolerance, verdict: "missing" });
      violations.push(`${scenario}: missing route p50 data`);
      continue;
    }

    const ratio = aotP50 / elysiaP50;
    if (ratio > tolerance) {
      checks.push({ scenario, elysiaP50, aotP50, ratio, tolerance, verdict: "slower" });
      violations.push(
        `${scenario}: ignus-aot ${aotP50.toFixed(3)}ms vs elysia ${elysiaP50.toFixed(3)}ms ` +
          `(x${ratio.toFixed(2)}, tolerance x${tolerance})`,
      );
    } else {
      checks.push({ scenario, elysiaP50, aotP50, ratio, tolerance, verdict: "ok" });
    }
  }

  return { checks, violations };
}

/** Where a report's freshness timestamp came from. */
export type FreshnessSource = "generatedAt" | "mtime" | "missing";

/** One report's freshness input for {@link evaluateFreshness}. */
export interface ReportFreshness {
  scenario: string;
  server: string;
  /**
   * Epoch-ms of the report's own clock. The CLI derives this from the report's
   * `generatedAt` when present, else the file mtime.
   */
  timestampMs: number | null;
  source: FreshnessSource;
}

/** Result of the stale-evidence guard. */
export interface FreshnessEvaluation {
  /** Human-readable stale-report lines (empty = fresh). */
  violations: string[];
  /** Number of reports flagged stale (0 when `allowStale` or all fresh). */
  stale: number;
  /** Number of reports inspected. */
  checked: number;
}

/**
 * Parse a `generatedAt` ISO timestamp to epoch-ms.
 *
 * @param value - Report `generatedAt` (may be `undefined`).
 * @returns Epoch-ms, or `null` when absent/unparseable.
 */
export function parseGeneratedAt(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Stale-evidence guard: refuse reports generated before the producer reference.
 *
 * A report is stale when its timestamp is strictly older than `sinceMs`. A
 * report with no timestamp (`source === "missing"`, i.e. no `generatedAt` and
 * no readable mtime) is treated as stale — missing evidence is not fresh
 * evidence. Pass `allowStale` to opt out (used by `--allow-stale`).
 *
 * @param reports - Freshness entries for every report the gate compared.
 * @param sinceMs - Producer reference time (epoch-ms).
 * @param options - `{ allowStale }` to disable the guard.
 * @returns Stale violations plus counts.
 */
export function evaluateFreshness(
  reports: ReadonlyArray<ReportFreshness>,
  sinceMs: number,
  options: { allowStale?: boolean } = {},
): FreshnessEvaluation {
  const checked = reports.length;
  if (options.allowStale) return { violations: [], stale: 0, checked };

  const violations: string[] = [];
  let stale = 0;
  for (const report of reports) {
    if (report.timestampMs !== null && report.timestampMs >= sinceMs) continue;
    stale++;
    const detail =
      report.timestampMs === null
        ? "no generatedAt/mtime"
        : `generated ${new Date(report.timestampMs).toISOString()} (${Math.round((sinceMs - report.timestampMs) / 1000)}s before the reference)`;
    violations.push(
      `${report.server}/${report.scenario}: stale report — ${detail} (from ${report.source})`,
    );
  }
  return { violations, stale, checked };
}

/**
 * Derive a {@link ReportFreshness} entry from a report + optional file mtime.
 *
 * Prefers the report's own `generatedAt` clock over the file mtime, since the
 * mtime can be rewritten by a copy/checkout while the measured time cannot.
 *
 * @param server - Participant name (`elysia` / `ignus-aot`).
 * @param scenario - Scenario name.
 * @param report - Parsed compare report.
 * @param mtimeMs - File mtime in epoch-ms, when the file was stat-able.
 * @returns The freshness entry the guard consumes.
 */
export function reportFreshness(
  server: string,
  scenario: string,
  report: CompareReport,
  mtimeMs: number | null,
): ReportFreshness {
  const generated = parseGeneratedAt(report.generatedAt);
  if (generated !== null) {
    return { server, scenario, timestampMs: generated, source: "generatedAt" };
  }
  if (mtimeMs !== null) {
    return { server, scenario, timestampMs: mtimeMs, source: "mtime" };
  }
  return { server, scenario, timestampMs: null, source: "missing" };
}
