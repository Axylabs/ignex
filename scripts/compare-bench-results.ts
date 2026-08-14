/**
 * Compare comparison-benchmark result JSONs.
 *
 * Prints per-server (bun/elysia/ignus) achieved RPS + avg/p50/p95/p99/max for
 * the given scenarios, and — when two result dirs are supplied — the ratio
 * current/baseline for the same server so latency deltas are obvious.
 *
 * Usage:
 *   bun scripts/compare-bench-results.ts <baseDir> [currentDir]
 *
 * Example:
 *   bun scripts/compare-bench-results.ts bench/results/compare.baseline-2026-08-14 bench/results/compare
 */
import { existsSync, readFileSync } from "node:fs";

const baseDir = process.argv[2] ?? "bench/results/compare";
const currentDir = process.argv[3];

const SERVERS = ["bun", "elysia", "ignus", "ignus-aot"] as const;
const SCENARIOS = [
  "01-smoke",
  "06-edge-cases",
  "13-heavy-json-nested",
  "14-heavy-json-arrays",
  "15-heavy-json-wide",
  "16-crud-validation-mix",
  "17-json-validation-spike",
  "20-validation-storm",
] as const;

interface Metrics {
  rps: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

const load = (dir: string, server: string, scenario: string): Metrics | null => {
  const path = `${dir}/${server}/${scenario}.bench.json`;
  if (!existsSync(path)) return null;
  const d = JSON.parse(readFileSync(path, "utf8")) as {
    achievedRps: number;
    global: { avg: number; p50: number; p95: number; p99: number; max: number };
  };
  return {
    rps: d.achievedRps,
    avg: d.global.avg,
    p50: d.global.p50,
    p95: d.global.p95,
    p99: d.global.p99,
    max: d.global.max,
  };
};

const fmt = (n: number): string => (Number.isFinite(n) ? n.toFixed(3) : "—");
const row = (cells: (string | number)[]): string => `| ${cells.join(" | ")} |`;

const header = row(["Server", "RPS", "avg", "p50", "p95", "p99", "max"]);
const sep = `|${header.slice(1, -1).replace(/[^|]/g, "---")}|`;

for (const scenario of SCENARIOS) {
  console.log(`\n## ${scenario}`);
  console.log(header);
  console.log(sep);
  for (const server of SERVERS) {
    const base = load(baseDir, server, scenario);
    const cur = currentDir ? load(currentDir, server, scenario) : null;
    if (!base) continue;
    const cells = [
      server,
      base.rps.toFixed(1),
      fmt(base.avg),
      fmt(base.p50),
      fmt(base.p95),
      fmt(base.p99),
      fmt(base.max),
    ];
    console.log(row(cells));
    if (cur) {
      const ratio = (a: number, b: number): string => (b > 0 ? (a / b).toFixed(3) : "—");
      console.log(
        row([
          `  ${server} (Δ)`,
          "",
          `×${ratio(cur.avg, base.avg)}`,
          `×${ratio(cur.p50, base.p50)}`,
          `×${ratio(cur.p95, base.p95)}`,
          `×${ratio(cur.p99, base.p99)}`,
          `×${ratio(cur.max, base.max)}`,
        ]),
      );
    }
  }
}
