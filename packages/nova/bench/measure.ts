/** Micro-benchmark helper: warmup + min-of-N ns/op (best case, like castrum bench/measure.ts). */
export function measureNs(
  fn: () => void,
  { warmup = 2000, runs = 20000 }: { warmup?: number; runs?: number } = {},
): number {
  for (let i = 0; i < warmup; i++) fn();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const dt = Number(process.hrtime.bigint() - t0);
    if (dt < best) best = dt;
  }
  return best;
}
