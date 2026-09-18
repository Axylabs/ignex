#!/usr/bin/env bun
/**
 * @fileoverview scripts/check-compare-gate.ts — Elysia-relative performance gate.
 *
 * The core claim of ignex is "AOT-compiled ignus is faster than Elysia on the
 * same workload". This gate asserts it from the saved compare-bench reports
 * (`bench/results/compare/`): for every scenario present in BOTH `elysia` and
 * `ignus-aot`, the ignus-aot per-route median p50 must be ≤ elysia p50 ×
 * TOLERANCE (default 1.10 — a 10% head room for run-to-run noise). Scenarios
 * where ignus-aot is expected to lose are declared in `KNOWN_SLOWER` with their
 * own (looser) tolerance so the gate is honest instead of silently skipped.
 *
 * The benchmark is rate-paced, so p50 includes pacing think-time — but BOTH
 * servers see the same pacing, making p50 a fair relative comparison. The
 * throughput scenarios (02-load, 03-stress, 10-mixed, 11-burst, 16-crud,
 * 17-validation-spike, 20-validation-storm) are where ignus-aot should win;
 * the low-rate error-path scenarios are pacing-dominated and use KNOWN_SLOWER.
 *
 * NOTE (2026-09-14): latency is now measured around each request only, and the
 * generator is sharded so it can actually saturate the server. In a scenario
 * with an unpaced phase (e.g. 03-stress "Max") the per-route p50 therefore
 * reflects the SATURATED operating point, so the ratio here is effectively a
 * throughput comparison — which is the intent for the throughput scenarios.
 * Read the per-phase table in the reports to separate per-op latency from
 * capacity.
 *
 * STALE-EVIDENCE GUARD (2026-09-19): the gate reads SAVED reports, so a stale
 * `bench/results/compare/` tree could pass while fresh code regressed. Every
 * compared report must now carry a timestamp NEWER than the producer reference
 * (`--since`, default = the newest `bench/compare/**\/*.ts` mtime). The
 * timestamp is the report's own `generatedAt` clock when present (preferred —
 * it cannot be rewritten by a copy/checkout), else the file mtime. Pass
 * `--allow-stale` to opt out, or `--since <ISO|epoch-ms>` to pin the reference.
 *
 * Decision logic lives in the pure `./lib/compare-gate.ts` module so the CLI
 * and its deterministic `--self-test` share it and it can be reasoned about
 * without a benchmark run.
 *
 * CLI:
 *   (none)             run the gate (default)
 *   --self-test        run deterministic checks of the gate + freshness guard
 *                      (injected regression must fail, control must pass); no
 *                      benchmark run needed
 *   --allow-stale      skip the stale-evidence guard
 *   --since <ref>      producer reference time: ISO-8601 date or epoch-ms
 *
 * Env:
 *   GATE_TOLERANCE=n   global p50 tolerance multiplier (default 1.10)
 *
 * Usage: `bun scripts/check-compare-gate.ts` — exits 1 on any violation.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type CompareReport,
  type CompareScenarioInput,
  type CompareTolerances,
  DEFAULT_COMPARE_TOLERANCE,
  evaluateCompareGate,
  evaluateFreshness,
  KNOWN_SLOWER,
  reportFreshness,
} from "./lib/compare-gate";

const RESULTS = new URL("../bench/results/compare/", import.meta.url).pathname;
const PRODUCER_DIR = new URL("../bench/compare/", import.meta.url).pathname;

const tolerances: CompareTolerances = {
  default: Number(process.env.GATE_TOLERANCE ?? DEFAULT_COMPARE_TOLERANCE),
  knownSlower: KNOWN_SLOWER,
};

/** A report plus the file mtime used as a freshness fallback. */
interface LoadedReport {
  report: CompareReport;
  mtimeMs: number | null;
}

/** Load one saved report; `null` when absent/unreadable. */
const load = (server: string, scenario: string): LoadedReport | null => {
  const path = join(RESULTS, server, `${scenario}.bench.json`);
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as CompareReport;
    let mtimeMs: number | null = null;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    const report: CompareReport = {
      server: raw.server,
      scenario: raw.scenario,
      routes: raw.routes ?? [],
    };
    if (raw.generatedAt !== undefined) report.generatedAt = raw.generatedAt;
    return { report, mtimeMs };
  } catch {
    return null;
  }
};

/** All scenarios present in both elysia + ignus-aot reports. */
const scenarios = (): string[] => {
  const names = (files: string[]): Set<string> =>
    new Set(
      files.filter((f) => f.endsWith(".bench.json")).map((f) => f.replace(/\.bench\.json$/, "")),
    );
  let elysia: string[];
  let aot: string[];
  try {
    elysia = readdirSync(join(RESULTS, "elysia"));
    aot = readdirSync(join(RESULTS, "ignus-aot"));
  } catch {
    return [];
  }
  const e = names(elysia);
  const a = names(aot);
  return [...e].filter((s) => a.has(s)).sort();
};

/** Newest `.ts` mtime under `bench/compare/` (the report producer). */
function newestProducerMtime(dir: string): number | null {
  let newest = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      try {
        const mtime = statSync(path).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        // unreadable entry — ignore
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  return newest > 0 ? newest : null;
}

/** Parse `--since`: ISO-8601 date, or digits interpreted as epoch-ms. */
function parseSince(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/** Parse CLI flags (returns the resolved reference + options). */
function parseArgs(args: string[]): {
  selfTest: boolean;
  allowStale: boolean;
  since: string | undefined;
} {
  let since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--since") {
      since = args[i + 1];
      i++;
    } else if (arg.startsWith("--since=")) {
      since = arg.slice("--since=".length);
    }
  }
  return {
    selfTest: args.includes("--self-test"),
    allowStale: args.includes("--allow-stale"),
    since,
  };
}

/** Print the per-scenario verdict table from a gate evaluation. */
function printChecks(evaluation: ReturnType<typeof evaluateCompareGate>): void {
  for (const check of evaluation.checks) {
    if (check.verdict === "ok" && check.elysiaP50 !== null && check.aotP50 !== null) {
      console.log(
        `  ✓ ${check.scenario}: ignus-aot ${check.aotP50.toFixed(3)}ms vs elysia ` +
          `${check.elysiaP50.toFixed(3)}ms (x${check.ratio?.toFixed(2)})`,
      );
    } else if (check.verdict === "slower") {
      console.error(`  ✗ ${evaluation.violations.find((v) => v.startsWith(`${check.scenario}:`))}`);
    } else {
      console.error(`  ✗ ${check.scenario}: missing route p50 data`);
    }
  }
}

/** Default mode: evaluate tolerance + freshness over the saved reports. */
async function runGate(options: { allowStale: boolean; since: string | undefined }): Promise<void> {
  const scenarioList = scenarios();
  if (scenarioList.length === 0) {
    console.error("[compare-gate] no shared scenario reports found — run bench:compare first.");
    process.exit(1);
  }

  const loaded: Array<{ scenario: string; elysia: LoadedReport; aot: LoadedReport }> = [];
  for (const scenario of scenarioList) {
    const elysia = load("elysia", scenario);
    const aot = load("ignus-aot", scenario);
    if (elysia && aot) loaded.push({ scenario, elysia, aot });
  }

  console.log(
    `[compare-gate] ignus-aot vs elysia per-route median p50 (tolerance ${tolerances.default}×)`,
  );
  const inputs: CompareScenarioInput[] = loaded.map(({ scenario, elysia, aot }) => ({
    scenario,
    elysia: elysia.report,
    aot: aot.report,
  }));
  const evaluation = evaluateCompareGate(inputs, tolerances);
  printChecks(evaluation);

  // ── Stale-evidence guard ──
  const sinceMs =
    options.since !== undefined ? parseSince(options.since) : newestProducerMtime(PRODUCER_DIR);
  let staleCount = 0;
  if (sinceMs === null) {
    if (options.since !== undefined) {
      console.error(
        `[compare-gate] invalid --since value "${options.since}" (want ISO-8601 or epoch-ms).`,
      );
      process.exit(1);
    }
    console.warn(
      "[compare-gate] freshness check skipped: no --since and no bench/compare/**/*.ts source found.",
    );
  } else {
    const freshnessInputs = loaded.flatMap(({ scenario, elysia, aot }) => [
      reportFreshness("elysia", scenario, elysia.report, elysia.mtimeMs),
      reportFreshness("ignus-aot", scenario, aot.report, aot.mtimeMs),
    ]);
    const freshness = evaluateFreshness(freshnessInputs, sinceMs, {
      allowStale: options.allowStale,
    });
    staleCount = freshness.stale;
    if (options.allowStale) {
      console.log(
        `[compare-gate] freshness guard DISABLED (--allow-stale); reference ${new Date(sinceMs).toISOString()}`,
      );
    } else {
      console.log(
        `[compare-gate] freshness: reference ${new Date(sinceMs).toISOString()} ` +
          `(newest bench/compare/ source mtime); ${freshness.checked} report(s) checked`,
      );
      if (freshness.stale > 0) {
        for (const violation of freshness.violations) console.error(`  ✗ ${violation}`);
        console.error(
          `[compare-gate] ${freshness.stale} stale report(s) — re-run \`bun run bench:compare\` ` +
            "or pass --allow-stale to override.",
        );
      }
    }
  }

  if (evaluation.violations.length > 0) {
    console.error(
      `[compare-gate] ${evaluation.violations.length} p50 violation(s) — ignus-aot slower than the gate allows.`,
    );
  }

  if (evaluation.violations.length > 0 || staleCount > 0) process.exit(1);

  console.log(
    `[compare-gate] OK — ignus-aot within tolerance on all ${loaded.length} scenarios` +
      (staleCount === 0 && sinceMs !== null ? " and all reports fresh." : "."),
  );
}

/**
 * `--self-test`: deterministic proof that the gate can FAIL.
 *
 * Mirrors Elysia's D1 injected-regression self-test: a control must pass, an
 * injected ratio regression must violate, the KNOWN_SLOWER tolerance must be
 * honoured on both sides, and the stale guard must reject an old report while
 * `--allow-stale` opts out. All vectors are synthetic/in-memory (no benchmark
 * run). When a saved report pair exists, it is additionally cloned + regressed
 * to prove the real-data loader path feeds the same pure decision.
 */
function runSelfTest(): boolean {
  const FRESH = "2030-01-01T00:00:00.000Z";
  const SINCE = Date.parse("2029-01-01T00:00:00.000Z");
  const make = (
    server: string,
    scenario: string,
    p50s: number[],
    generatedAt: string,
  ): CompareReport => ({
    server,
    scenario,
    generatedAt,
    routes: p50s.map((p50, i) => ({ name: `GET /r${i}`, p50 })),
  });

  let ok = true;
  const report = (name: string, passed: boolean, detail: string): void => {
    if (!passed) ok = false;
    console.log(`  ${passed ? "✓" : "✗"} ${name} (${detail})`);
  };

  console.log("compare-gate self-test:");

  // 1. Control — ignus-aot equal to elysia is within tolerance.
  {
    const e = evaluateCompareGate(
      [
        {
          scenario: "01-smoke",
          elysia: make("elysia", "01-smoke", [1, 2, 3], FRESH),
          aot: make("ignus-aot", "01-smoke", [1, 2, 3], FRESH),
        },
      ],
      tolerances,
    );
    report(
      "control — ratio 1.0 within tolerance",
      e.violations.length === 0,
      `violations=${e.violations.length}`,
    );
  }

  // 2. Injected regression — x10 p50 must violate.
  {
    const e = evaluateCompareGate(
      [
        {
          scenario: "01-smoke",
          elysia: make("elysia", "01-smoke", [1, 2, 3], FRESH),
          aot: make("ignus-aot", "01-smoke", [10, 20, 30], FRESH),
        },
      ],
      tolerances,
    );
    report(
      "injected regression — x10 p50 violates",
      e.violations.length === 1,
      `violations=${e.violations.length}`,
    );
  }

  // 3. KNOWN_SLOWER tolerance honoured: 1.2 passes 03-stress (1.35) but 1.4 fails.
  {
    const at = (ratio: number) =>
      evaluateCompareGate(
        [
          {
            scenario: "03-stress",
            elysia: make("elysia", "03-stress", [1], FRESH),
            aot: make("ignus-aot", "03-stress", [ratio], FRESH),
          },
        ],
        tolerances,
      );
    const inside = at(1.2);
    const outside = at(1.4);
    report(
      "KNOWN_SLOWER — x1.2 passes / x1.4 fails 03-stress",
      inside.violations.length === 0 && outside.violations.length === 1,
      `inside=${inside.violations.length}, outside=${outside.violations.length}`,
    );
  }

  // 4. Freshness control — fresh reports pass.
  {
    const fresh = evaluateFreshness(
      [
        reportFreshness("elysia", "01-smoke", make("elysia", "01-smoke", [1], FRESH), null),
        reportFreshness("ignus-aot", "01-smoke", make("ignus-aot", "01-smoke", [1], FRESH), null),
      ],
      SINCE,
    );
    report(
      "freshness control — fresh reports pass",
      fresh.violations.length === 0,
      `violations=${fresh.violations.length}`,
    );
  }

  // 5. Stale guard — an old report violates, and --allow-stale opts out.
  {
    const old = "2020-01-01T00:00:00.000Z";
    const inputs = [
      reportFreshness("elysia", "01-smoke", make("elysia", "01-smoke", [1], old), null),
      reportFreshness("ignus-aot", "01-smoke", make("ignus-aot", "01-smoke", [1], old), null),
    ];
    const stale = evaluateFreshness(inputs, SINCE);
    const allowed = evaluateFreshness(inputs, SINCE, { allowStale: true });
    report(
      "stale guard — old report fails / --allow-stale passes",
      stale.violations.length === 2 && allowed.violations.length === 0,
      `stale=${stale.violations.length}, allowed=${allowed.violations.length}`,
    );
  }

  // 6. Missing timestamp is stale (missing evidence is not fresh evidence).
  {
    const missing = evaluateFreshness(
      [{ scenario: "01-smoke", server: "elysia", timestampMs: null, source: "missing" }],
      SINCE,
    );
    report(
      "stale guard — missing timestamp fails",
      missing.violations.length === 1,
      `violations=${missing.violations.length}`,
    );
  }

  // 7. Real-data probe (best effort): clone a saved report pair, inject a
  // regression, and confirm the pure decision flags it. Proves the loader and
  // the report field mapping, not just synthetic shapes.
  const probe = realReportRegressionProbe();
  if (probe === null) {
    console.log("  ~ real-data probe skipped (no saved elysia/ignus-aot report pair)");
  } else {
    report("real-data probe — cloned saved report + x100 aot violates", probe, `violated=${probe}`);
  }

  return ok;
}

/**
 * Clone the first saved elysia/ignus-aot report pair, multiply ignus-aot's p50s
 * by 100, and run the pure gate. `null` when no pair is available.
 */
function realReportRegressionProbe(): boolean | null {
  const scenario = scenarios()[0];
  if (scenario === undefined) return null;
  const elysia = load("elysia", scenario);
  const aot = load("ignus-aot", scenario);
  if (!elysia || !aot) return null;
  const regressed: CompareReport = {
    ...aot.report,
    routes: aot.report.routes.map((route) => ({ ...route, p50: route.p50 * 100 })),
  };
  const evaluation = evaluateCompareGate(
    [{ scenario, elysia: elysia.report, aot: regressed }],
    tolerances,
  );
  return evaluation.violations.length > 0;
}

const args = process.argv.slice(2);
const parsed = parseArgs(args);

if (parsed.selfTest) {
  // Only exit(1) on failure; on success fall through so redirected stdout is
  // flushed before the process ends (process.exit can truncate it).
  if (!runSelfTest()) process.exit(1);
} else {
  await runGate({ allowStale: parsed.allowStale, since: parsed.since });
}
