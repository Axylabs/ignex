/**
 * @fileoverview Adaptive batch-size control for DataLoader. Sampled batch
 * latency drives a bounded limit: saturated fast batches grow, slow batches
 * shrink. No clock read occurs between samples.
 */

/** Runtime tuning for DataLoader's adaptive batch-size controller. */
export interface AdaptiveDataLoaderOptions {
  /** Smallest learned batch size. Default 8. */
  readonly minBatchSize?: number;
  /** Largest learned batch size. Default 1024, capped by `maxBatchSize`. */
  readonly maxBatchSize?: number;
  /** Cold-start batch size, clamped between the minimum and maximum. */
  readonly initialBatchSize?: number;
  /** Target batch-function duration in milliseconds. Default 1 ms. */
  readonly targetBatchMs?: number;
  /** Measure one batch per this many dispatches. Default 16. */
  readonly sampleEvery?: number;
  /** EWMA weight for a new latency sample, in (0, 1]. Default 0.25. */
  readonly ewmaAlpha?: number;
  /** Monotonic nanosecond clock, injectable for deterministic tests. */
  readonly nowNs?: () => number;
}

/** Current adaptive controller measurements. */
export interface AdaptiveBatchSnapshot {
  readonly batchSize: number;
  readonly averageBatchMs: number;
  readonly samples: number;
}

/** Internal stateful controller; one instance belongs to one DataLoader. */
export interface AdaptiveBatchController extends AdaptiveBatchSnapshot {
  start(): number | null;
  finish(start: number, size: number): void;
}

const bunNanoseconds = (globalThis as { Bun?: { nanoseconds?: () => number } }).Bun?.nanoseconds;
const defaultNowNs = (): number =>
  typeof bunNanoseconds === "function" ? bunNanoseconds() : performance.now() * 1e6;
const integerAtLeast = (value: number, minimum: number): number =>
  Math.max(minimum, Math.floor(value));

/** Create the bounded latency-feedback controller used by adaptive loaders. */
export const createAdaptiveBatchController = (
  options: AdaptiveDataLoaderOptions | true,
  configuredMax: number,
): AdaptiveBatchController => {
  const tuning = options === true ? {} : options;
  const max = Math.max(1, Math.min(configuredMax, integerAtLeast(tuning.maxBatchSize ?? 1024, 1)));
  const min = Math.min(max, integerAtLeast(tuning.minBatchSize ?? 8, 1));
  const targetNs = Math.max(0.001, tuning.targetBatchMs ?? 1) * 1e6;
  const sampleEvery = integerAtLeast(tuning.sampleEvery ?? 16, 1);
  const alpha = Math.min(1, Math.max(0.01, tuning.ewmaAlpha ?? 0.25));
  const nowNs = tuning.nowNs ?? defaultNowNs;
  let batchSize = Math.min(max, Math.max(min, integerAtLeast(tuning.initialBatchSize ?? min, 1)));
  let averageNs = 0;
  let samples = 0;
  let dispatches = 0;

  return {
    get batchSize() {
      return batchSize;
    },
    get averageBatchMs() {
      return averageNs / 1e6;
    },
    get samples() {
      return samples;
    },
    start() {
      dispatches++;
      return dispatches % sampleEvery === 0 ? nowNs() : null;
    },
    finish(start, size) {
      const elapsed = nowNs() - start;
      if (!(elapsed > 0) || size <= 0) return;
      averageNs = averageNs === 0 ? elapsed : averageNs + alpha * (elapsed - averageNs);
      samples++;
      if (averageNs > targetNs * 1.2) {
        batchSize = Math.max(min, Math.floor(batchSize / 2));
      } else if (size >= batchSize && averageNs < targetNs * 0.5) {
        batchSize = Math.min(max, batchSize * 2);
      }
    },
  };
};
