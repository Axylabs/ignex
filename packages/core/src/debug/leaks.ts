/**
 * @fileoverview LeakDetector — memory / event-loop trend analysis.
 *
 * A pure analyzer over the profiler's sample ring: least-squares trends for
 * heap and RSS over a trailing window, fit-quality gating (R²) so noise is
 * not reported as a leak, sustained event-loop saturation detection and an
 * in-flight-request growth check. Every finding carries its measured
 * evidence and a concrete recommendation, so the dashboard (and MCP agents)
 * can act without recomputation. No timers, no globals — safe to call from
 * any request or endpoint.
 */

import type { DiagnosticsReport, LeakFinding, SystemSample } from "./types";

/** Options for {@link analyzeSamples}. */
export interface LeakAnalysisOptions {
  /**
   * Trailing window in ms used for trend fitting. Default 600_000 (10 min);
   * shorter sample spans are analyzed whole.
   */
  readonly windowMs?: number;
  /** Heap slope (MiB/min) above which a warning is raised. Default 0.5. */
  readonly heapWarnMiBPerMin?: number;
  /** Heap slope (MiB/min) above which a critical is raised. Default 4. */
  readonly heapCriticalMiBPerMin?: number;
  /** Minimum R² for heap/RSS trends to count as real. Default 0.6. */
  readonly minR2?: number;
  /** p95 event-loop delay (ms) treated as saturated. Default 50. */
  readonly eventLoopWarnMs?: number;
  /**
   * Minimum window span (minutes) before ANY memory-growth finding is
   * emitted. Shorter spans are dominated by JIT warmup and cache/ring
   * fill-up — perfectly linear short-term, indistinguishable from a leak.
   * Default 2.
   */
  readonly minWindowMin?: number;
  /**
   * Minimum window span (minutes) before a memory finding may be CRITICAL.
   * Below this a qualifying trend is still reported, as a warning — real
   * leaks confirm themselves over time; warmup never does. Default 5.
   */
  readonly criticalWindowMin?: number;
}

const DEFAULTS = {
  windowMs: 600_000,
  heapWarnMiBPerMin: 0.5,
  heapCriticalMiBPerMin: 4,
  minR2: 0.6,
  eventLoopWarnMs: 50,
  minWindowMin: 2,
  criticalWindowMin: 5,
} as const;

/**
 * A finding requires at least this much TOTAL growth over the window
 * (whichever bound is larger): 8 MiB absolute or 10% of the starting value.
 * Slope alone misleads — a one-off burst of allocations scores a huge
 * MiB/min over a tiny window without being a leak.
 */
const warnGrowthMiB = (startMiB: number): number => Math.max(8, Math.abs(startMiB) * 0.1);

/**
 * CRITICAL additionally requires this much total growth (larger of 16 MiB
 * or 25% of the starting value) on top of the longer confirmation window.
 */
const criticalGrowthMiB = (startMiB: number): number => Math.max(16, Math.abs(startMiB) * 0.25);

/** Round to one decimal (report-friendly). */
const r1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Least-squares fit of `y` over `x`. Returns slope (per x-unit), intercept,
 * R² and the point count. O(n), no allocations beyond locals.
 */
export const linearTrend = (
  xs: number[],
  ys: number[],
): { slope: number; r2: number; n: number } => {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { slope: 0, r2: 0, n };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] ?? 0;
    const y = ys[i] ?? 0;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, r2: 0, n };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  let ssTot = 0;
  let ssRes = 0;
  const meanY = sy / n;
  for (let i = 0; i < n; i++) {
    const y = ys[i] ?? 0;
    const fitted = slope * (xs[i] ?? 0) + intercept;
    ssTot += (y - meanY) * (y - meanY);
    ssRes += (y - fitted) * (y - fitted);
  }
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, r2, n };
};

/** Everything the memory-trend finding needs (pre-classified by `memRule`). */
interface MemFindingInput {
  readonly id: string;
  readonly label: string;
  readonly seriesLabel: string;
  readonly windowMin: number;
  readonly start: number;
  readonly now: number;
  readonly min: number;
  readonly max: number;
  readonly growth: number;
  readonly slope: number;
  readonly r2: number;
  /** Recent-tail slope (`null` when the window is too short to fit one). */
  readonly tailSlope: number | null;
  readonly plateaued: boolean;
  readonly critical: boolean;
  /** Effective threshold (for the "not yet confirmed" note). */
  readonly criticalWindowMin: number;
}

/**
 * Build the memory-trend {@link LeakFinding} from a pre-classified trend
 * (extracted from the analysis closure so rule logic and message formatting
 * stay independently readable).
 */
const memFinding = (m: MemFindingInput): LeakFinding => ({
  id: m.id,
  severity: m.plateaued ? "info" : m.critical ? "critical" : "warning",
  title: `${m.label} climbing ${r1(m.slope)} MiB/min`,
  detail: m.plateaued
    ? `${m.seriesLabel} grew ${r1(m.min)} → ${r1(m.now)} MiB over the last ${m.windowMin} min, but the recent tail is flat (${r1(m.tailSlope ?? 0)} MiB/min over the last half of the window) — the climb stopped. This looks like warm-up or a saturating cache/ring, not an ongoing leak; keep watching in case it resumes.`
    : `${m.seriesLabel} grew ${r1(m.min)} → ${r1(m.now)} MiB (+${r1(m.growth)} MiB over the last ${m.windowMin} min) with a strong linear fit (R²=${r1(m.r2)}) and was still climbing at the end of the window${m.critical ? "" : ` — not yet confirmed over ${m.criticalWindowMin}+ min`}. Sustained linear growth with no plateau is the signature of a leak, not of caching.`,
  evidence: {
    slopeMiBPerMin: r1(m.slope),
    tailSlopeMiBPerMin: r1(m.tailSlope ?? m.slope),
    r2: r1(m.r2),
    windowMin: m.windowMin,
    startMiB: r1(m.min),
    nowMiB: r1(m.now),
    peakMiB: r1(m.max),
    growthMiB: r1(m.growth),
    growthPctOfStart: r1(m.start !== 0 ? (m.growth / Math.abs(m.start)) * 100 : 100),
  },
  recommendation:
    m.id === "heap-growth"
      ? "Run GC from Diagnostics and compare before/after; snapshot the heap and look for growing arrays/maps/closures; audit ctx.debug span retention and module-level caches."
      : "RSS outgrowing the JS heap usually means native/buffer growth: audit Buffer allocations, native addon arenas and unbounded file caches.",
});

/**
 * Analyze profiler samples and produce a diagnostics report.
 *
 * Rules (each emits at most one finding):
 * 1. `heap-growth` — sustained heap-used climb over the trailing window
 *    (slope gated by R²); severity scales with MiB/min.
 * 2. `rss-growth` — same idea on RSS (catches leaks outside the JS heap:
 *    native addons, buffers, file caches).
 * 3. `event-loop-saturation` — p95 loop delay above threshold across the
 *    window (sync CPU hogs, blocked I/O fan-out, timer storms).
 * 4. `active-requests-growth` — in-flight requests that never come back
 *    down: the classic "response never finalized" leak.
 *
 * @param samples Sample series (any length; oldest → newest order assumed).
 * @param options Threshold/window overrides.
 * @returns A full {@link DiagnosticsReport}; `verdict: "ok"` when healthy.
 */
export const analyzeSamples = (
  samples: readonly SystemSample[],
  options: LeakAnalysisOptions = {},
): DiagnosticsReport => {
  const opts = { ...DEFAULTS, ...options };
  const findings: LeakFinding[] = [];
  const checkedAt = Date.now();

  // Trailing window slice (or everything when the span is shorter).
  let windowed = [...samples];
  if (windowed.length > 1) {
    const newestTs = windowed[windowed.length - 1]?.ts ?? 0;
    windowed = windowed.filter((s) => s.ts >= newestTs - opts.windowMs);
  }

  if (windowed.length < 5) {
    return {
      verdict: "ok",
      checkedAt,
      windowMin: 0,
      samplesAnalyzed: windowed.length,
      findings: [],
      trend: {
        heapMiBPerMin: 0,
        heapR2: 0,
        heapNowMiB: windowed[windowed.length - 1]?.heapMiB ?? 0,
        heapMinMiB: windowed[0]?.heapMiB ?? 0,
        heapMaxMiB: windowed[0]?.heapMiB ?? 0,
        rssMiBPerMin: 0,
        eventLoopP95Ms: 0,
        activeRequestsMax: 0,
      },
    };
  }

  const first = windowed[0];
  const last = windowed[windowed.length - 1] ?? first;
  const t0 = first?.ts ?? 0;
  if (!first || !last) {
    return {
      verdict: "ok",
      checkedAt,
      windowMin: 0,
      samplesAnalyzed: 0,
      findings: [],
      trend: {
        heapMiBPerMin: 0,
        heapR2: 0,
        heapNowMiB: 0,
        heapMinMiB: 0,
        heapMaxMiB: 0,
        rssMiBPerMin: 0,
        eventLoopP95Ms: 0,
        activeRequestsMax: 0,
      },
    };
  }
  const minutes = (ts: number): number => (ts - t0) / 60_000;
  const xs = windowed.map((s) => minutes(s.ts));
  const heaps = windowed.map((s) => s.heapMiB);
  const rsses = windowed.map((s) => s.rssMiB);
  const heapTrend = linearTrend(xs, heaps);
  const rssTrend = linearTrend(xs, rsses);
  const delays = windowed.map((s) => s.eventLoopDelayMs).sort((a, b) => a - b);
  const delayP95 = delays[Math.min(delays.length - 1, Math.floor(delays.length * 0.95))] ?? 0;
  const activeMax = windowed.reduce((m, s) => Math.max(m, s.activeRequests), 0);
  const heapNow = heaps[heaps.length - 1] ?? 0;
  const windowMin = r1(minutes(last.ts));

  // Rules 1 + 2: memory growth trends.
  const memRule = (
    id: string,
    label: string,
    seriesLabel: string,
    xs: number[],
    ys: number[],
    trend: { slope: number; r2: number; n: number },
  ): void => {
    if (trend.r2 < opts.minR2 || trend.slope < opts.heapWarnMiBPerMin) return;
    if (windowMin < opts.minWindowMin) return; // too little evidence — warmup territory
    const start = ys[0] ?? 0;
    const now = ys[ys.length - 1] ?? 0;
    const growth = now - start;
    if (growth < warnGrowthMiB(start)) return;
    // Plateau check: fit the recent tail (second half of the window). A real
    // leak keeps climbing to the very end; a fill-up transient (cache/ring
    // warm-up, one-off burst) goes flat once it saturates.
    const half = Math.floor(ys.length / 2);
    const tailLen = ys.length - half;
    const tailTrend = tailLen >= 8 ? linearTrend(xs.slice(half), ys.slice(half)) : null;
    const plateaued = tailTrend !== null && tailTrend.slope < opts.heapWarnMiBPerMin;
    const critical =
      !plateaued &&
      windowMin >= opts.criticalWindowMin &&
      trend.slope >= opts.heapCriticalMiBPerMin &&
      growth >= criticalGrowthMiB(start);
    findings.push(
      memFinding({
        id,
        label,
        seriesLabel,
        windowMin,
        start,
        now,
        min: Math.min(...ys),
        max: Math.max(...ys),
        growth,
        slope: trend.slope,
        r2: trend.r2,
        tailSlope: tailTrend?.slope ?? null,
        plateaued,
        critical,
        criticalWindowMin: opts.criticalWindowMin,
      }),
    );
  };

  memRule("heap-growth", "Heap", "Heap used", xs, heaps, heapTrend);
  memRule("rss-growth", "RSS", "RSS", xs, rsses, rssTrend);

  // Rule 3: event-loop saturation.
  if (delayP95 >= opts.eventLoopWarnMs) {
    findings.push({
      id: "event-loop-saturation",
      severity: delayP95 >= opts.eventLoopWarnMs * 4 ? "critical" : "warning",
      title: `Event loop p95 delay ${r1(delayP95)} ms`,
      detail: `The event loop's 95th-percentile delay stayed above ${opts.eventLoopWarnMs} ms across the last ${windowMin} min. Requests and timers queue up behind whatever blocks the loop.`,
      evidence: { p95DelayMs: r1(delayP95), thresholdMs: opts.eventLoopWarnMs, windowMin },
      recommendation:
        "Look for long synchronous work in handlers (big JSON.stringify, crypto loops, regex backtracking) and move it off the hot path; re-run bench:* after fixing.",
    });
  }

  // Rule 4: in-flight requests never draining.
  const tail = windowed.slice(-30);
  const nonDecreasing =
    tail.length >= 10 &&
    tail.every((s, i) => i === 0 || s.activeRequests >= (tail[i - 1]?.activeRequests ?? 0));
  const tailLast = tail[tail.length - 1]?.activeRequests ?? 0;
  if (nonDecreasing && tailLast >= 25) {
    findings.push({
      id: "active-requests-growth",
      severity: "warning",
      title: `In-flight requests only grow (${tailLast})`,
      detail: `Active requests rose monotonically across the last ${tail.length} samples and never drained — some responses are likely never finalized (hanging awaits, missing timeouts).`,
      evidence: { peakActive: activeMax, lastSamples: tail.length, windowMin },
      recommendation:
        "Check for awaits without timeouts on outbound calls, SSE/WS streams left open, and hooks that never resolve; the Requests panel's oldest entries are the suspects.",
    });
  }

  const worst: DiagnosticsReport["verdict"] = findings.some((f) => f.severity === "critical")
    ? "critical"
    : findings.some((f) => f.severity === "warning")
      ? "warning"
      : "ok";

  return {
    verdict: worst,
    checkedAt,
    windowMin,
    samplesAnalyzed: windowed.length,
    findings,
    trend: {
      heapMiBPerMin: r1(heapTrend.slope),
      heapR2: r1(heapTrend.r2),
      heapNowMiB: r1(heapNow),
      heapMinMiB: r1(Math.min(...heaps)),
      heapMaxMiB: r1(Math.max(...heaps)),
      rssMiBPerMin: r1(rssTrend.slope),
      eventLoopP95Ms: r1(delayP95),
      activeRequestsMax: activeMax,
    },
  };
};

/**
 * Force a full garbage collection where the runtime allows it (Bun exposes
 * `Bun.gc(true)`), then report freed memory. Used by the Diagnostics view's
 * "run GC" action and the `/api/diagnostics/gc` endpoint.
 *
 * @returns Freed bytes (0 when the runtime has no force-GC hook).
 */
export const forceGc = (): number => {
  const bun = (globalThis as unknown as { Bun?: { gc?: (force: boolean) => number | undefined } })
    .Bun;
  if (typeof bun?.gc !== "function") return 0;
  try {
    const freed: number | undefined = bun.gc(true);
    return typeof freed === "number" ? Math.max(0, freed) : 0;
  } catch {
    return 0;
  }
};
