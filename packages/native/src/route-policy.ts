/**
 * @fileoverview Adaptive per-route execution policy — picks native vs JS per
 * request, learning from SAMPLED timings under the current system load (the
 * sampled-EWMA + load-aware model castrum's loader already uses for its
 * batcher, re-expressed here for routes without a package crossing).
 *
 * Static `nativeRoutes` fixes native-vs-JS at AOT time. The adaptive layer
 * (compiler option `nativeRoutesAdaptive`) keeps the PLAN fixed (same stages)
 * but lets the IMPLEMENTATION float inside two request-size buckets: each
 * bucket tracks an EWMA of the native vs JS prelude duration measured ON the
 * live server — so CPU contention, co-tenancy, or a castrum build that shifts
 * the native/JS ratio moves the preference, and calm load moves it back.
 *
 * Hot-path discipline (this runs on EVERY request of an adaptive route):
 * - steady state: one counter increment + one comparison — no clock read, no
 *   allocation; the decision is the bucket's current preference boolean.
 * - sampled requests (1/`sampleEvery`): allocate one small choice token that
 *   carries the start timestamp; the generated prelude passes it back to
 *   {@link recordExecution} once the whole prelude (native OR JS path) is
 *   done, so both implementations are measured over the same span.
 * - bootstrap + bounded exploration make sure both implementations keep
 *   fresh measurements; hysteresis keeps a noisy EWMA pair from flapping.
 */

import { type NativeRoutePlan, planHasStage } from "./route-wire";

/** A sampled-request token: the decision, when the clock started, and which
 *  bucket owns the measurement. Allocated ONLY on sampled requests (the
 *  steady-state path returns a bare boolean). */
export interface NativeRouteChoice {
  readonly native: boolean;
  /** Start timestamp in ns (from the policy's clock) — prelude entry. */
  readonly start: number;
  /** Bucket index: 0 = small, 1 = large (see {@link RouteExecutionTuning}). */
  readonly bucket: 0 | 1;
}

/** Per-bucket learned state (see {@link createRouteExecutionPolicy}). */
export interface RoutePolicySnapshot {
  readonly bucket: "small" | "large";
  readonly preferNative: boolean;
  /** EWMA of measured prelude durations, ns. `0` = no samples yet. */
  readonly nativeNs: number;
  readonly fallbackNs: number;
  readonly nativeSamples: number;
  readonly fallbackSamples: number;
}

/** Tuning knobs. Defaults are the castrum-loader cadence; tests inject all of
 *  them (plus `nowNs`) to make learning deterministic. */
export interface RouteExecutionTuning {
  /** Monotonic nanosecond clock. Default `Bun.nanoseconds()` (µs-resolution
   *  `performance.now()` fallback off Bun). */
  readonly nowNs?: () => number;
  /** Sample 1-in-N requests per bucket. Default 64. */
  readonly sampleEvery?: number;
  /** Samples per mode per bucket before the preference may flip. Default 16. */
  readonly minSamples?: number;
  /** After bootstrap, probe the non-preferred mode every Nth sampled request. */
  readonly exploreEvery?: number;
  /** Bucket split: request bytes (query + cookie + body) below this are
   *  "small". Default 512. */
  readonly bucketBytes?: number;
  /** EWMA weight of a new sample (0 < alpha <= 1). Default 0.25. */
  readonly ewmaAlpha?: number;
  /** A mode must be FASTER by this fraction to take over (anti-flap band).
   *  Default 0.1. */
  readonly hysteresis?: number;
}

const DEFAULT_SAMPLE_EVERY = 64;
const DEFAULT_MIN_SAMPLES = 16;
const DEFAULT_EXPLORE_EVERY = 4;
const DEFAULT_BUCKET_BYTES = 512;
const DEFAULT_EWMA_ALPHA = 0.25;
const DEFAULT_HYSTERESIS = 0.1;

// Feature-detected once at module load (mirrors bun.ts's detect-once idiom):
// `Bun.nanoseconds()` is the monotonic ns clock the generated server targets.
const g = globalThis as { Bun?: { nanoseconds?: () => number } };
const bunNanoseconds = g.Bun?.nanoseconds;
const defaultNowNs: () => number =
  typeof bunNanoseconds === "function" ? bunNanoseconds : () => performance.now() * 1e6;

/**
 * Cold-start priors per bucket `[small, large]` — the static-measurement
 * defaults (bench/ selection ratios: queryPairs x0.28, cookiePairs x0.105,
 * validators x0.007 vs JS), corrected by learning. Body-verdict routes start
 * native at every size (the raw-bytes validation IS the whole job); query
 * routes start native only when the payload is large enough to amortize the
 * crossing; a cookie-only parse starts JS at every size (the fixed crossing
 * dominates at realistic cookie sizes).
 */
const initialPreference = (plan: NativeRoutePlan): [boolean, boolean] => {
  if (planHasStage(plan, "requireJsonBody") || planHasStage(plan, "validateBody")) {
    return [true, true];
  }
  if (planHasStage(plan, "parseQuery")) return [false, true];
  return [false, false];
};

/** EWMA step: first sample seeds, later samples blend at `alpha`. */
const ewma = (cur: number, sample: number, alpha: number): number =>
  cur === 0 ? sample : cur + alpha * (sample - cur);

/**
 * Build the per-route adaptive selector over a compiled plan. Pure factory:
 * the returned closures own the only mutable state (two bucket records), so
 * concurrent requests share ONE consistent model per route without locks —
 * a raced EWMA update costs at most one lost sample, never a wrong decision
 * structure.
 */
export const createRouteExecutionPolicy = (
  plan: NativeRoutePlan,
  tuning: RouteExecutionTuning = {},
): {
  chooseExecution(
    query: string,
    cookie: string,
    body: Uint8Array | null,
  ): boolean | NativeRouteChoice;
  recordExecution(choice: NativeRouteChoice, endNs: number): void;
  snapshot(): readonly RoutePolicySnapshot[];
} => {
  const nowNs = tuning.nowNs ?? defaultNowNs;
  const sampleEvery = Math.max(2, tuning.sampleEvery ?? DEFAULT_SAMPLE_EVERY);
  const minSamples = Math.max(1, tuning.minSamples ?? DEFAULT_MIN_SAMPLES);
  const exploreEvery = Math.max(2, tuning.exploreEvery ?? DEFAULT_EXPLORE_EVERY);
  const bucketBytes = tuning.bucketBytes ?? DEFAULT_BUCKET_BYTES;
  const alpha = Math.min(1, Math.max(0.01, tuning.ewmaAlpha ?? DEFAULT_EWMA_ALPHA));
  const hysteresis = Math.min(0.5, Math.max(0, tuning.hysteresis ?? DEFAULT_HYSTERESIS));
  const priors = initialPreference(plan);

  interface Bucket {
    nativeNs: number;
    fallbackNs: number;
    nativeSamples: number;
    fallbackSamples: number;
    /** Total requests seen (drives the 1-in-N sampling cadence). */
    ticks: number;
    /** Sampled requests seen (drives exploration cadence). */
    samples: number;
    preferNative: boolean;
  }
  const buckets: [Bucket, Bucket] = [
    {
      nativeNs: 0,
      fallbackNs: 0,
      nativeSamples: 0,
      fallbackSamples: 0,
      ticks: 0,
      samples: 0,
      preferNative: priors[0],
    },
    {
      nativeNs: 0,
      fallbackNs: 0,
      nativeSamples: 0,
      fallbackSamples: 0,
      ticks: 0,
      samples: 0,
      preferNative: priors[1],
    },
  ];

  return {
    /**
     * The per-request gate. Steady state returns the bucket's current
     * preference (boolean, no allocation); every `sampleEvery`-th request of
     * a bucket returns a {@link NativeRouteChoice} token instead — bootstraps
     * whichever mode still lacks `minSamples`, then probes the non-preferred
     * mode every `exploreEvery`-th sampled request so the learned comparison
     * never goes stale as load changes.
     */
    chooseExecution(query, cookie, body) {
      const bytes = query.length + cookie.length + (body === null ? 0 : body.byteLength);
      const b = buckets[bytes < bucketBytes ? 0 : 1];
      b.ticks++;
      if (b.ticks % sampleEvery !== 0) return b.preferNative;
      b.samples++;
      let native = b.preferNative;
      if (b.fallbackSamples < minSamples) native = false;
      else if (b.nativeSamples < minSamples) native = true;
      else if (b.samples % exploreEvery === 0) native = !b.preferNative;
      return { native, start: nowNs(), bucket: b === buckets[0] ? 0 : 1 };
    },

    /**
     * Fold a sampled request's measured prelude duration into its bucket's
     * EWMA and re-evaluate the preference. Both modes must have `minSamples`
     * AND the winner must lead by more than the hysteresis band before the
     * preference flips — under stable load the model converges, under churn
     * it follows with damping instead of oscillating.
     */
    recordExecution(choice, endNs) {
      const b = buckets[choice.bucket];
      const dt = endNs - choice.start;
      if (dt <= 0) return; // clock anomaly — never let it poison the model
      if (choice.native) {
        b.nativeNs = ewma(b.nativeNs, dt, alpha);
        b.nativeSamples++;
      } else {
        b.fallbackNs = ewma(b.fallbackNs, dt, alpha);
        b.fallbackSamples++;
      }
      if (b.nativeSamples < minSamples || b.fallbackSamples < minSamples) return;
      if (b.nativeNs < b.fallbackNs * (1 - hysteresis)) b.preferNative = true;
      else if (b.fallbackNs < b.nativeNs * (1 - hysteresis)) b.preferNative = false;
    },

    /** Learned state for tests and the observatory. Read-only copy. */
    snapshot() {
      return buckets.map((b, i) => ({
        bucket: i === 0 ? ("small" as const) : ("large" as const),
        preferNative: b.preferNative,
        nativeNs: b.nativeNs,
        fallbackNs: b.fallbackNs,
        nativeSamples: b.nativeSamples,
        fallbackSamples: b.fallbackSamples,
      }));
    },
  };
};
