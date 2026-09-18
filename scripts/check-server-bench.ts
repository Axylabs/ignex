#!/usr/bin/env bun
/**
 * @fileoverview CI regression gate for the end-to-end compiled-server benchmark.
 *
 * Compares the freshly-written `bench/results/server/latest.json` (produced by
 * `bun run bench:server`) against the committed `baseline.json`. Fails when:
 *   1. any route's NATIVE req/s regresses more than `NATIVE_RPS_REGRESSION`
 *      (default 10%) vs the committed baseline, or
 *   2. NATIVE req/s falls more than `NATIVE_VS_FALLBACK_DEGRADE` (default 15%)
 *      behind the FALLBACK run in the same `latest.json` (the native layer must
 *      never be meaningfully slower than pure-JS).
 *
 * The comparison itself lives in the pure `./lib/server-bench-compare.ts` module
 * so it can be reasoned about and exercised without a benchmark run.
 *
 * CLI:
 *   (none)             run the gate (default)
 *   --self-test        run deterministic synthetic checks of the comparator and
 *                      exit 0/1 (no benchmark run, no files needed)
 *   --update-baseline  promote `latest.json` → `baseline.json` (with a trailing
 *                      newline) and print the route table; fails loudly if the
 *                      latest run is missing `native`/`fallback` modes
 *                      (used by `bun run bench:server:baseline`)
 *
 * Env overrides:
 *   NATIVE_RPS_REGRESSION     — allowed native-vs-baseline drop (default 0.10)
 *   NATIVE_VS_FALLBACK_DEGRADE— allowed native-vs-fallback drop (default 0.15)
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compareServerReports,
  DEFAULT_SERVER_BENCH_THRESHOLDS,
  type ServerBenchReport,
} from "./lib/server-bench-compare";

const RESULTS_DIR = new URL("../bench/results/server/", import.meta.url).pathname;
const thresholds = {
  rps: Number(process.env.NATIVE_RPS_REGRESSION ?? DEFAULT_SERVER_BENCH_THRESHOLDS.rps),
  fallback: Number(
    process.env.NATIVE_VS_FALLBACK_DEGRADE ?? DEFAULT_SERVER_BENCH_THRESHOLDS.fallback,
  ),
};

const readReport = async (file: string): Promise<ServerBenchReport> => {
  const raw = await readFile(join(RESULTS_DIR, file), "utf8");
  return JSON.parse(raw) as ServerBenchReport;
};

/** Print the route table for a report (one block per mode). */
function printRouteTable(report: ServerBenchReport): void {
  for (const mode of report.modes) {
    console.log(`[${mode.mode}]`);
    for (const route of mode.routes) {
      console.log(`  ${route.label.padEnd(34)} rps=${route.rps.toFixed(1)}`);
    }
  }
}

/**
 * `--update-baseline`: promote the current latest run to the committed baseline.
 *
 * Fails loudly if `latest.json` is missing or does not contain both `native` and
 * `fallback` modes — a partial run must never become the baseline (the gate
 * needs both to apply its checks).
 */
async function updateBaseline(): Promise<void> {
  const latestPath = join(RESULTS_DIR, "latest.json");
  const raw = await readFile(latestPath, "utf8");
  const latest = JSON.parse(raw) as ServerBenchReport;

  const modes = new Set(latest.modes.map((m) => m.mode));
  const missing = ["native", "fallback"].filter((m) => !modes.has(m));
  if (missing.length > 0) {
    console.error(
      `cannot update baseline: latest.json is missing mode(s) ${missing.join(", ")} — re-run \`bun run bench:server\` with MODE=both (or all).`,
    );
    process.exit(1);
  }

  const baselinePath = join(RESULTS_DIR, "baseline.json");
  await writeFile(baselinePath, raw.endsWith("\n") ? raw : `${raw}\n`);
  printRouteTable(latest);
  console.log(`\nbaseline updated from latest.json: ${baselinePath}`);
}

type BenchParams = Pick<ServerBenchReport, "durationSec" | "warmupSec" | "concurrency" | "repeats">;

/** Build a synthetic report for the self-test (deterministic, tiny vectors). */
function makeSyntheticReport(
  native: ReadonlyArray<readonly [string, number]>,
  fallback: ReadonlyArray<readonly [string, number]>,
  overrides: Partial<BenchParams> = {},
): ServerBenchReport {
  return {
    durationSec: 3,
    warmupSec: 1,
    concurrency: 32,
    repeats: 3,
    ...overrides,
    modes: [
      { mode: "native", routes: native.map(([label, rps]) => ({ label, rps })) },
      { mode: "fallback", routes: fallback.map(([label, rps]) => ({ label, rps })) },
    ],
  };
}

/**
 * `--self-test`: deterministic checks that the comparator catches an injected
 * regression, catches a native-behind-fallback run, skips the baseline check on
 * mismatched params, and passes a control identical to the baseline.
 *
 * @returns `true` when every case behaves as expected.
 */
function runSelfTest(): boolean {
  const baseline = makeSyntheticReport([["GET /health", 1000]], [["GET /health", 900]]);
  // Matches its native baseline but is 30% behind its fallback run, isolating
  // the native-vs-fallback failure class.
  const fallbackDegradeBaseline = makeSyntheticReport(
    [["GET /health", 700]],
    [["GET /health", 700]],
  );
  const cases: Array<{
    name: string;
    latest: ServerBenchReport;
    baseline: ServerBenchReport;
    expectFailures: boolean;
    expectParamsMatch: boolean;
  }> = [
    {
      name: "control — identical to baseline",
      latest: makeSyntheticReport([["GET /health", 1000]], [["GET /health", 900]]),
      baseline,
      expectFailures: false,
      expectParamsMatch: true,
    },
    {
      name: "regression — native 15% below baseline",
      latest: makeSyntheticReport([["GET /health", 850]], [["GET /health", 900]]),
      baseline,
      expectFailures: true,
      expectParamsMatch: true,
    },
    {
      name: "degrade — native 30% behind fallback (baseline matched)",
      latest: makeSyntheticReport([["GET /health", 700]], [["GET /health", 1000]]),
      baseline: fallbackDegradeBaseline,
      expectFailures: true,
      expectParamsMatch: true,
    },
    {
      name: "params mismatch — baseline check skipped",
      latest: makeSyntheticReport([["GET /health", 850]], [["GET /health", 900]], {
        durationSec: 1,
      }),
      baseline,
      expectFailures: false,
      expectParamsMatch: false,
    },
  ];

  let ok = true;
  console.log("server-bench comparator self-test:");
  for (const testCase of cases) {
    const { failures, paramsMatch } = compareServerReports(
      testCase.latest,
      testCase.baseline,
      DEFAULT_SERVER_BENCH_THRESHOLDS,
    );
    const gotFailures = failures.length > 0;
    const passed =
      gotFailures === testCase.expectFailures && paramsMatch === testCase.expectParamsMatch;
    if (!passed) ok = false;
    console.log(
      `  ${passed ? "✓" : "✗"} ${testCase.name} (failures=${failures.length}, paramsMatch=${paramsMatch})`,
    );
    if (!passed) {
      console.error(
        `      expected failures=${testCase.expectFailures ? ">0" : "0"}, paramsMatch=${testCase.expectParamsMatch}`,
      );
    }
  }
  return ok;
}

/** Default mode: compare the latest run against the committed baseline. */
async function runGate(): Promise<void> {
  const latest = await readReport("latest.json");
  let baseline: ServerBenchReport;
  try {
    baseline = await readReport("baseline.json");
  } catch (err) {
    // baseline.json is committed; a missing/unreadable baseline must be LOUD.
    // Silently falling back to `latest` would only re-run the in-run
    // native-vs-fallback check and could print "gate OK" — exactly the
    // false-assurance this gate exists to prevent.
    console.error(
      `server-bench gate cannot run: baseline.json is missing or unreadable (${err instanceof Error ? err.message : String(err)}). Run \`bun run bench:server:baseline\` to create it.`,
    );
    process.exit(1);
  }

  const { failures, paramsMatch } = compareServerReports(latest, baseline, thresholds);

  if (!paramsMatch) {
    console.log(
      `note: latest run params (dur=${latest.durationSec} warmup=${latest.warmupSec} conc=${latest.concurrency} reps=${latest.repeats}) differ from baseline (dur=${baseline.durationSec} warmup=${baseline.warmupSec} conc=${baseline.concurrency} reps=${baseline.repeats}) — only the native-vs-fallback check applied.`,
    );
  }

  if (failures.length > 0) {
    console.error("server-bench gate FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log("server-bench gate OK: native at/above baseline and within band of fallback.");
}

const args = process.argv.slice(2);

if (args.includes("--self-test")) {
  // Only exit(1) on failure; on success fall through so redirected stdout is
  // flushed before the process ends (process.exit can truncate it).
  if (!runSelfTest()) process.exit(1);
} else if (args.includes("--update-baseline")) {
  await updateBaseline();
} else {
  await runGate();
}
