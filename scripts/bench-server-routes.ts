#!/usr/bin/env bun
/**
 * scripts/bench-server-routes.ts — per-route ISOLATED end-to-end benchmark.
 *
 * Runs the end-to-end bench ONCE PER ROUTE (each route gets its own server
 * process), so per-route numbers are not distorted by cross-route CPU
 * contention in a shared-server mixed load. Prints a consolidated
 * raw-bun / native / fallback table (req/s + p50).
 *
 * Env overrides:
 *   REPEATS  — bench repeats per route (default 2)
 *   DURATION — bench timed-window seconds per mode (default 2)
 *   CONCURRENCY — connections (default 24)
 *   SKIP_BUILD — "1" to skip the AOT build
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const REPO = new URL("../", import.meta.url).pathname;
const RESULTS_DIR = new URL("../bench/results/server/", import.meta.url).pathname;
const REPEATS = Number(process.env.REPEATS ?? 2);
const DURATION = Number(process.env.DURATION ?? 2);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 24);
const SKIP_BUILD = process.env.SKIP_BUILD === "1";

const ROUTES = [
  "GET /health",
  "POST /api/orders (bulk JSON+schema)",
  "GET /api/search (60 params)",
  "GET /api/me (30 cookies+sess)",
  "GET /api/reports/42 (JWT)",
  "GET /catalog (120-item template)",
  "GET /api/big (256KB gzip)",
];

interface RouteStat {
  label: string;
  rps: number;
  p50Ms: number;
}

interface Report {
  modes: Array<{ mode: string; routes: RouteStat[] }>;
}

interface Row {
  label: string;
  rawBun: [number, number];
  native: [number, number];
  fallback: [number, number];
}

const rows: Row[] = [];

for (const label of ROUTES) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MODE: "all",
    REPEATS: String(REPEATS),
    DURATION: String(DURATION),
    WARMUP: "1",
    CONCURRENCY: String(CONCURRENCY),
    ROUTES: label,
  };
  if (SKIP_BUILD) env.SKIP_BUILD = "1";

  process.stdout.write(`bench ${label} ... `);
  const res = Bun.spawnSync(["bun", "scripts/bench-server.ts"], {
    cwd: REPO,
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (res.exitCode !== 0) {
    process.stdout.write(`exit ${res.exitCode ?? "?"}\n`);
    continue;
  }

  const report = JSON.parse(await readFile(join(RESULTS_DIR, "latest.json"), "utf8")) as Report;

  const stat = (mode: string): [number, number] => {
    const route = report.modes.find((m) => m.mode === mode)?.routes.find((r) => r.label === label);
    return [route?.rps ?? 0, route?.p50Ms ?? 0];
  };

  rows.push({
    label,
    rawBun: stat("raw-bun"),
    native: stat("native"),
    fallback: stat("fallback"),
  });
  process.stdout.write(`done\n`);
}

console.log("\n=== per-route isolated: req/s (p50 ms) — ratio = native/raw-bun ===\n");
console.log(
  `${"route".padEnd(34)} ${"raw-bun".padStart(14)} ${"native".padStart(14)} ${"fallback".padStart(14)} ${"nat/raw".padStart(8)}`,
);
for (const r of rows) {
  const ratio = r.rawBun[0] > 0 ? r.native[0] / r.rawBun[0] : Number.NaN;
  const ratioText = Number.isFinite(ratio) ? ratio.toFixed(2) : " n/a";
  console.log(
    `${r.label.padEnd(34)} ${`${r.rawBun[0].toFixed(0)} (${r.rawBun[1].toFixed(2)})`.padStart(14)} ${`${r.native[0].toFixed(0)} (${r.native[1].toFixed(2)})`.padStart(14)} ${`${r.fallback[0].toFixed(0)} (${r.fallback[1].toFixed(2)})`.padStart(14)} ${ratioText.padStart(8)}`,
  );
}
