/**
 * @fileoverview Size-aware adaptive execution for synchronous native/JS pairs.
 * Sampled EWMA timings learn the fastest implementation on the live process;
 * hysteresis and bounded exploration prevent oscillation without making the
 * steady-state path allocate or read a clock.
 */
import type { ExecutionBackend } from "./selection";

/** Snapshot of one payload-size bucket's learned execution costs. */
export interface AdaptiveExecutionSnapshot {
  /** Inclusive upper byte bound; `null` is the unbounded final bucket. */
  readonly maxBytes: number | null;
  /** Implementation currently preferred for this bucket. */
  readonly impl: ExecutionBackend;
  /** EWMA duration in nanoseconds; zero before the first valid sample. */
  readonly nativeNs: number;
  /** EWMA duration in nanoseconds; zero before the first valid sample. */
  readonly jsNs: number;
  readonly nativeSamples: number;
  readonly jsSamples: number;
}

/** Tuning for {@link createAdaptiveExecutor}. */
export interface AdaptiveExecutionOptions {
  /**
   * Initial preference per bucket. A callback receives the bucket's inclusive
   * upper bound (`MAX_SAFE_INTEGER` for the unbounded final bucket).
   */
  readonly initialImpl?: ExecutionBackend | ((bytes: number) => ExecutionBackend);
  /** Ascending inclusive bucket bounds. Default: 256 B, 4 KiB, 64 KiB, unlimited. */
  readonly sizeBuckets?: readonly number[];
  /** Whether the native callback can run. Unavailable native always uses JS. */
  readonly nativeAvailable?: () => boolean;
  /** Enable runtime learning. Default true; false keeps the initial decision. */
  readonly enabled?: boolean;
  /** Sample one call per this many calls in each bucket. Default 64. */
  readonly sampleEvery?: number;
  /** Required samples per implementation before switching. Default 8. */
  readonly minSamples?: number;
  /** Probe the non-preferred implementation every Nth sampled call. Default 4. */
  readonly exploreEvery?: number;
  /** EWMA weight for a new sample, in (0, 1]. Default 0.25. */
  readonly ewmaAlpha?: number;
  /** Required fractional speed advantage before switching. Default 0.1. */
  readonly hysteresis?: number;
  /** Monotonic nanosecond clock, injectable for deterministic tests. */
  readonly nowNs?: () => number;
}

/** A sampled execution token. Only sampled calls allocate this object. */
export interface AdaptiveExecutionChoice {
  readonly impl: ExecutionBackend;
  readonly bucket: number;
  readonly start: number;
}

/** A size-aware executor with observable learned state. */
export interface AdaptiveExecutor {
  /**
   * Choose an implementation. A boolean is the allocation-free fast path;
   * an object is a sampled call that must be passed to `record` afterward.
   */
  choose(bytes: number): boolean | AdaptiveExecutionChoice;
  /** Record a sampled choice using the executor's monotonic clock. */
  record(choice: AdaptiveExecutionChoice): void;
  /** Run the selected implementation for an input of `bytes` length. */
  execute<Value>(bytes: number, native: () => Value, js: () => Value): Value;
  /** Return a read-only copy of each bucket's learned state. */
  snapshot(): readonly AdaptiveExecutionSnapshot[];
}

interface Bucket {
  readonly maxBytes: number | null;
  impl: ExecutionBackend;
  nativeNs: number;
  jsNs: number;
  nativeSamples: number;
  jsSamples: number;
  ticks: number;
  samples: number;
}

const DEFAULT_BUCKETS = [256, 4096, 65_536];
const bunNanoseconds = (globalThis as { Bun?: { nanoseconds?: () => number } }).Bun?.nanoseconds;
const defaultNowNs = (): number =>
  typeof bunNanoseconds === "function" ? bunNanoseconds() : performance.now() * 1e6;
const ewma = (current: number, sample: number, alpha: number): number =>
  current === 0 ? sample : current + alpha * (sample - current);

/**
 * Create a runtime-learning dispatcher for two behaviorally identical callbacks.
 * Small and large payloads learn independently. The initial implementation is a
 * prior only: after bootstrap, sampled live timings can reverse it.
 */
export const createAdaptiveExecutor = (
  options: AdaptiveExecutionOptions = {},
): AdaptiveExecutor => {
  const enabled = options.enabled !== false;
  const nativeAvailable = options.nativeAvailable ?? (() => true);
  let nativeUsable: boolean | undefined;
  const canUseNative = (): boolean => {
    if (nativeUsable === undefined) nativeUsable = nativeAvailable();
    return nativeUsable;
  };
  const initialImpl = options.initialImpl ?? "js";
  const sampleEvery = Math.max(2, Math.floor(options.sampleEvery ?? 64));
  const minSamples = Math.max(1, Math.floor(options.minSamples ?? 8));
  const exploreEvery = Math.max(2, Math.floor(options.exploreEvery ?? 4));
  const alpha = Math.min(1, Math.max(0.01, options.ewmaAlpha ?? 0.25));
  const hysteresis = Math.min(0.5, Math.max(0, options.hysteresis ?? 0.1));
  const nowNs = options.nowNs ?? defaultNowNs;
  const limits = [...(options.sizeBuckets ?? DEFAULT_BUCKETS)]
    .filter((limit) => Number.isFinite(limit) && limit >= 0)
    .sort((a, b) => a - b);
  const buckets: Bucket[] = [...limits, null].map((maxBytes) => ({
    maxBytes,
    impl:
      typeof initialImpl === "function"
        ? initialImpl(maxBytes ?? Number.MAX_SAFE_INTEGER)
        : initialImpl,
    nativeNs: 0,
    jsNs: 0,
    nativeSamples: 0,
    jsSamples: 0,
    ticks: 0,
    samples: 0,
  }));
  const bucketFor = (bytes: number): Bucket => {
    const size = Math.max(0, bytes);
    for (const bucket of buckets) {
      if (bucket.maxBytes === null || size <= bucket.maxBytes) return bucket;
    }
    return buckets[buckets.length - 1] as Bucket;
  };
  const record = (bucket: Bucket, impl: ExecutionBackend, elapsedNs: number): void => {
    if (!(elapsedNs > 0)) return;
    if (impl === "castrum") {
      bucket.nativeNs = ewma(bucket.nativeNs, elapsedNs, alpha);
      bucket.nativeSamples++;
    } else {
      bucket.jsNs = ewma(bucket.jsNs, elapsedNs, alpha);
      bucket.jsSamples++;
    }
    if (bucket.nativeSamples < minSamples || bucket.jsSamples < minSamples) return;
    if (bucket.nativeNs < bucket.jsNs * (1 - hysteresis)) bucket.impl = "castrum";
    else if (bucket.jsNs < bucket.nativeNs * (1 - hysteresis)) bucket.impl = "js";
  };

  const choose = (bytes: number): boolean | AdaptiveExecutionChoice => {
    const bucket = bucketFor(bytes);
    bucket.ticks++;
    let impl = bucket.impl;
    const sampled = enabled && bucket.ticks % sampleEvery === 0;
    if (sampled) {
      bucket.samples++;
      if (bucket.jsSamples < minSamples) impl = "js";
      else if (bucket.nativeSamples < minSamples) impl = "castrum";
      else if (bucket.samples % exploreEvery === 0) impl = impl === "js" ? "castrum" : "js";
    }
    if (impl === "castrum" && !canUseNative()) return false;
    if (!sampled) return impl === "castrum";
    return { impl, bucket: buckets.indexOf(bucket), start: nowNs() };
  };
  const recordChoice = (choice: AdaptiveExecutionChoice): void => {
    const bucket = buckets[choice.bucket];
    if (bucket) record(bucket, choice.impl, nowNs() - choice.start);
  };

  return {
    choose,
    record: recordChoice,
    execute(bytes, native, js) {
      const choice = choose(bytes);
      if (typeof choice === "boolean") return choice ? native() : js();
      try {
        return choice.impl === "castrum" ? native() : js();
      } finally {
        recordChoice(choice);
      }
    },
    snapshot() {
      return buckets.map((bucket) => ({
        maxBytes: bucket.maxBytes,
        impl: bucket.impl,
        nativeNs: bucket.nativeNs,
        jsNs: bucket.jsNs,
        nativeSamples: bucket.nativeSamples,
        jsSamples: bucket.jsSamples,
      }));
    },
  };
};
