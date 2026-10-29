/**
 * @fileoverview Throughput measurement shared by the benchmark scripts.
 *
 * Every `bench-*` script needs the same loop: warm up, then count invocations
 * for a fixed wall-clock window and divide. It used to be copy-pasted into
 * four of them with slightly different warm-up counts, which made the reported
 * ops/sec numbers quietly incomparable between benches.
 *
 * Duration is a parameter rather than a constant so a caller that wants a
 * shorter or longer sample keeps its historical default explicitly.
 */

/**
 * Measure synchronous throughput in ops/sec.
 *
 * @param fn - Workload to measure; must be free of side effects that grow.
 * @param durationMs - Measurement window in milliseconds.
 * @param warmup - Iterations run before the clock starts.
 * @returns Invocations per second over the measurement window.
 */
export function opsPerSec(fn: () => void, durationMs = 250, warmup = 1_000): number {
  for (let i = 0; i < warmup; i++) fn();
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < durationMs) {
    fn();
    count++;
  }
  return count / ((performance.now() - start) / 1000);
}

/**
 * Measure asynchronous throughput in ops/sec.
 *
 * Each iteration is awaited, so the window measures round-trip latency-bound
 * work (crypto/JWT signing) rather than queued promises.
 *
 * @param fn - Async workload to measure.
 * @param durationMs - Measurement window in milliseconds.
 * @param warmup - Iterations run before the clock starts.
 * @returns Awaited invocations per second over the measurement window.
 */
export async function opsPerSecAsync(
  fn: () => Promise<unknown>,
  durationMs = 250,
  warmup = 500,
): Promise<number> {
  for (let i = 0; i < warmup; i++) await fn();
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < durationMs) {
    await fn();
    count++;
  }
  return count / ((performance.now() - start) / 1000);
}
