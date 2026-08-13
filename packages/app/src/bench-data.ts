/**
 * packages/app/src/bench-data.ts — deterministic realistic data for the
 * benchmark routes. Sizes deliberately match `bench/real-data.ts` so the
 * raw-Bun baseline and the ignex compiled server do comparable work.
 */

/** Shared signing secret used by the bench servers + fixtures. */
export const BENCH_SECRET = "ignex-bench-secret";

/** Deterministic 32-bit LCG (fixed seed) — identical across processes. */
let lcgState = 0x9e3779b9;
const resetLcg = (): void => {
  lcgState = 0x9e3779b9;
};
const rand = (): number => {
  lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0;
  return lcgState / 0x100000000;
};

export interface CatalogItem {
  id: number;
  name: string;
  price: string;
  stock: number;
  tags: string[];
  description: string;
}

/** A deterministic catalog of `n` items (for template rendering). */
export const catalogItems = (n = 120): CatalogItem[] => {
  resetLcg();
  const items: CatalogItem[] = [];
  for (let i = 0; i < n; i++) {
    items.push({
      id: i + 1,
      name: `Catalog Item ${i} ${rand().toString(36).slice(2, 7)}`,
      price: (rand() * 500).toFixed(2),
      stock: Math.floor(rand() * 1000),
      tags: ["new", "featured", "sale"].filter(() => rand() > 0.4),
      description: "A thoughtfully designed product for daily use. ".repeat(
        2 + Math.floor(rand() * 3),
      ),
    });
  }
  return items;
};

/** A large JSON document (~`kb` KB) for the big-response / gzip scenario. */
export const bigJson = (kb = 256): string => {
  resetLcg();
  const rows: Array<Record<string, unknown>> = [];
  const target = kb * 1024;
  let approx = 0;
  while (approx < target) {
    rows.push({
      id: rows.length,
      ts: 1_750_000_000 + rows.length,
      metric: Math.floor(rand() * 1_000_000),
      series: Array.from({ length: 8 }, () => Math.floor(rand() * 1000)),
      label: rand().toString(36).slice(2, 14).repeat(2),
    });
    approx += 220;
  }
  return JSON.stringify({ generated: kb, rows });
};
