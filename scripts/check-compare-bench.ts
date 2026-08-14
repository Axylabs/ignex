#!/usr/bin/env bun
/**
 * scripts/check-compare-bench.ts — validate saved comparison-bench results.
 *
 * Verifies the reports written by `bench/compare/run-bench.ts`:
 *  - every server produced results for the same set of scenarios,
 *  - each report has zero unexpected failures (timeouts / network errors /
 *    unexpected statuses / response-shape failures) and a non-zero request
 *    count — expected error responses (e.g. deliberate 400/415/422 flows) are
 *    fine and counted separately.
 *
 * Exits non-zero on any violation. Useful as a gate after a bench run.
 *
 * Env:
 *   SCENARIO=<substr>  only check scenario reports whose name includes <substr>
 *   SERVER=<kind>      only check the given server (bun | elysia | ignus)
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const RESULTS_ROOT = new URL("../bench/results/compare/", import.meta.url).pathname;
const ALL_SERVERS = ["bun", "elysia", "ignus", "ignus-aot"] as const;
/**
 * Default check set (also the default run set — `run-bench.ts` now includes
 * `ignus-aot`, so the gate validates all four participants after a full run).
 */
const DEFAULT_SERVERS = ["bun", "elysia", "ignus", "ignus-aot"] as const;

interface Report {
  server: string;
  scenario: string;
  totalRequests: number;
  failed: number;
  timeouts: number;
  networkErrors: number;
  unexpectedStatuses: number;
  shapeFailures: number;
  errorRatePct: number;
}

const filterScenario = process.env.SCENARIO ?? "";
const filterServer = process.env.SERVER ?? "";
const servers = filterServer ? ALL_SERVERS.filter((s) => s === filterServer) : [...DEFAULT_SERVERS];

let violations = 0;

const fail = (msg: string): void => {
  violations++;
  console.error(`  ✗ ${msg}`);
};

async function loadReports(server: string): Promise<Map<string, Report>> {
  const dir = join(RESULTS_ROOT, server);
  const reports = new Map<string, Report>();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    console.error(`  ✗ ${server}: no results directory ${dir}`);
    violations++;
    return reports;
  }
  for (const file of files.sort()) {
    if (!file.endsWith(".bench.json")) continue;
    const scenario = file.replace(/\.bench\.json$/, "");
    if (filterScenario && !scenario.includes(filterScenario)) continue;
    try {
      const raw = await readFile(join(dir, file), "utf8");
      const parsed = JSON.parse(raw) as Report;
      reports.set(scenario, parsed);
    } catch (err) {
      fail(
        `${server}/${file}: unreadable or invalid JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return reports;
}

/** Collect problems for a single report (empty array = clean). */
function reportProblems(report: Report): string[] {
  const problems: string[] = [];
  if (report.totalRequests <= 0) problems.push("totalRequests === 0");
  if (report.failed !== 0) problems.push(`failed=${report.failed}`);
  if (report.timeouts !== 0) problems.push(`timeouts=${report.timeouts}`);
  if (report.networkErrors !== 0) problems.push(`networkErrors=${report.networkErrors}`);
  if (report.unexpectedStatuses !== 0)
    problems.push(`unexpectedStatuses=${report.unexpectedStatuses}`);
  if (report.shapeFailures !== 0) problems.push(`shapeFailures=${report.shapeFailures}`);
  if (report.errorRatePct !== 0) problems.push(`errorRatePct=${report.errorRatePct}%`);
  return problems;
}

/** Load + validate every report for one server; returns the report map. */
async function checkServerReports(server: string): Promise<Map<string, Report>> {
  console.log(`\n[${server}]`);
  const reports = await loadReports(server);

  if (reports.size === 0) {
    fail("no .bench.json reports found");
    return reports;
  }

  for (const [scenario, report] of reports) {
    const problems = reportProblems(report);
    if (problems.length > 0) {
      fail(`${scenario}: ${problems.join(", ")}`);
    } else {
      console.log(
        `  ✓ ${scenario}  (${report.totalRequests} req, rps clean, 0 unexpected failures)`,
      );
    }
  }
  return reports;
}

/** Assert every server ran the same scenario set. */
function checkParity(perServer: Map<string, Map<string, Report>>): void {
  const reference = perServer.get(servers[0] ?? "bun");
  if (!reference || reference.size === 0) return;

  const expected = new Set(reference.keys());
  for (const [server, reports] of perServer) {
    const missing = [...expected].filter((s) => !reports.has(s));
    if (missing.length > 0) fail(`${server}: missing scenarios ${missing.join(", ")}`);

    const extra = [...reports.keys()].filter((s) => !expected.has(s));
    if (extra.length > 0) {
      console.warn(`  ! ${server}: extra scenarios ${extra.join(", ")} (not in ${servers[0]})`);
    }
  }
}

async function main(): Promise<void> {
  console.log("checking comparison bench results in", RESULTS_ROOT);

  const perServer = new Map<string, Map<string, Report>>();
  for (const server of servers) {
    perServer.set(server, await checkServerReports(server));
  }

  checkParity(perServer);

  if (violations > 0) {
    console.error(`\n✗ comparison bench check FAILED (${violations} violation(s))`);
    process.exit(1);
  }
  console.log("\n✓ comparison bench check passed");
}

await main();
