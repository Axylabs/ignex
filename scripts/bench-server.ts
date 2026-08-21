#!/usr/bin/env bun
/**
 * @fileoverview End-to-end benchmark of the AOT-compiled app server.
 *
 * Boots `packages/app/dist/__server.js` as a child process and runs a mixed
 * HTTP load across the app's hot routes, measuring per-route request rate and
 * latency percentiles. Runs the server with the Rust addon ON and (optionally)
 * with `IGNEX_NATIVE=off` so native-vs-fallback is comparable in one pass.
 *
 * To cancel machine drift, thermal state and per-run noise, the modes are
 * INTERLEAVED (`REPEATS` times, alternating which mode runs first) and the
 * reported per-route numbers are the MEDIAN across repeats for each mode.
 *
 * This is the yardstick for every performance change: record a baseline with
 * `bun run bench:server`, then re-run after wiring/porting work and confirm
 * native-on does not regress (and ideally improves) p50/p95 vs the committed
 * baseline in `bench/results/server/latest.json`.
 *
 * Env overrides:
 *   PORT        — server port (default 3100; both modes reuse it sequentially)
 *   DURATION    — timed-window seconds per mode per repeat (default 3)
 *   WARMUP      — warm-up seconds before the timed window per mode (default 1)
 *   CONCURRENCY — parallel connections (default 32)
 *   REPEATS     — number of interleaved A/B rounds (default 3)
 *   MODE        — "native" | "fallback" | "raw-bun" | "both" | "all" (default "all")
 *   MODE_FIRST  — "native" (default) | "fallback": which mode runs first
 *   SKIP_BUILD  — "1" to skip the AOT build (assumes dist/__server.js is fresh)
 *   ROUTES      — comma-separated route labels to bench (default: all)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bearerToken, cookieHeader, ordersBody, searchQuery } from "../bench/real-data";

const PORT = Number(process.env.PORT ?? 3100);
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR = new URL("../packages/app/", import.meta.url).pathname;
const RESULTS_DIR = new URL("../bench/results/server/", import.meta.url).pathname;
const DURATION_S = Number(process.env.DURATION ?? 3);
const WARMUP_S = Number(process.env.WARMUP ?? 1);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);
const REPEATS = Math.max(1, Number(process.env.REPEATS ?? 3));
const MODE = (process.env.MODE ?? "all").toLowerCase();
const SKIP_BUILD = process.env.SKIP_BUILD === "1";

type Mode = "native" | "fallback" | "raw-bun";

interface RouteSpec {
  label: string;
  path: string;
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
}

// Real-workload routes: bulk JSON+schema, many-param query, many cookies+session,
// JWT per request, template-heavy page, large gzip response (+ /health sanity).
const ROUTES: RouteSpec[] = [
  { label: "GET /health", path: "/health" },
  {
    label: "POST /api/orders (bulk JSON+schema)",
    path: "/api/orders",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: ordersBody(80),
  },
  { label: "GET /api/search (60 params)", path: `/api/search?${searchQuery(60)}` },
  {
    label: "GET /api/me (30 cookies+sess)",
    path: "/api/me",
    headers: { cookie: cookieHeader(30) },
  },
  {
    label: "GET /api/reports/42 (JWT)",
    path: "/api/reports/42",
    headers: { authorization: `Bearer ${bearerToken()}` },
  },
  { label: "GET /catalog (120-item template)", path: "/catalog" },
  {
    label: "GET /api/big (256KB gzip)",
    path: "/api/big",
    headers: { "accept-encoding": "gzip" },
  },
];

const selectedLabels = (process.env.ROUTES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const routes =
  selectedLabels.length > 0 ? ROUTES.filter((r) => selectedLabels.includes(r.label)) : ROUTES;

if (routes.length === 0) {
  console.error(`no routes selected (ROUTES=${process.env.ROUTES ?? ""})`);
  process.exit(1);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

interface RouteResult {
  label: string;
  requests: number;
  rps: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

interface ModeResult {
  mode: Mode;
  warmupSec: number;
  durationSec: number;
  repeats: number;
  routes: RouteResult[];
  totalRequests: number;
  totalErrors: number;
}

interface RouteComparison {
  label: string;
  referenceMode: Mode;
  otherMode: Mode;
  referenceRps: number;
  otherRps: number;
  rpsRatio: number;
  referenceP50Ms: number;
  otherP50Ms: number;
  p50Ratio: number;
}

/** One load run against a live server; returns per-route latencies + error count. */
async function runLoad(): Promise<{ latencies: Map<string, number[]>; errors: number }> {
  const latencies = new Map<string, number[]>();
  let errors = 0;

  const hitRoute = async (spec: RouteSpec, record: boolean): Promise<void> => {
    const start = performance.now();
    try {
      const init: RequestInit = { method: spec.method ?? "GET" };
      if (spec.headers) init.headers = spec.headers;
      if (spec.body) init.body = spec.body;
      const res = await fetch(`${BASE}${spec.path}`, init);
      await res.arrayBuffer();
      if (res.status >= 500) errors += 1;
      if (record) {
        const arr = latencies.get(spec.label) ?? [];
        arr.push(performance.now() - start);
        latencies.set(spec.label, arr);
      }
    } catch {
      errors += 1;
    }
  };

  const runWindow = async (ms: number, record: boolean): Promise<void> => {
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async (_, wi) => {
        // Pin each worker to ONE route so routes measure independently
        // (a mixed round-robin client gets throttled by the heaviest route
        // and flattens every route to the same rate). Per-route concurrency
        // is ~CONCURRENCY / routes.length.
        const spec = routes[wi % routes.length];
        if (!spec) return;
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          await hitRoute(spec, record);
        }
      }),
    );
  };

  if (WARMUP_S > 0) await runWindow(WARMUP_S * 1000, false);
  await runWindow(DURATION_S * 1000, true);
  return { latencies, errors };
}

/** Boot the server for `mode`, run one load window, tear it down, return results. */
async function runOnce(mode: Mode): Promise<{
  routes: RouteResult[];
  errors: number;
}> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORT),
    ...(mode === "fallback" ? { IGNEX_NATIVE: "off" } : {}),
    // The bench measures plain-HTTP throughput; keep the ignex server on
    // HTTP/1 so TLS handshakes don't skew the comparison with raw Bun.
    IGNEX_HTTPS: "0",
  };

  const isRawBun = mode === "raw-bun";
  const proc = Bun.spawn(
    isRawBun ? ["bun", "bench/servers/raw-bun-server.ts"] : ["bun", "dist/__server.js"],
    {
      cwd: isRawBun ? new URL("../", import.meta.url).pathname : APP_DIR,
      env,
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  const waitForServer = async (timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.status === 200) return;
      } catch {
        // server not up yet — keep polling
      }
      await delay(150);
    }
    throw new Error(`server did not become ready in ${timeoutMs}ms`);
  };

  try {
    await waitForServer(10_000);
  } catch (err) {
    proc.kill("SIGKILL");
    throw err;
  }

  const { latencies, errors } = await runLoad();

  proc.kill(); // SIGTERM — graceful
  await delay(300);
  try {
    proc.kill("SIGKILL"); // force-kill if still alive; no-op if already exited
  } catch {
    // already exited
  }

  const routeResults: RouteResult[] = routes.map((spec) => {
    const arr = (latencies.get(spec.label) ?? []).sort((a, b) => a - b);
    const requests = arr.length;
    return {
      label: spec.label,
      requests,
      rps: requests / DURATION_S,
      avgMs: requests > 0 ? arr.reduce((a, b) => a + b, 0) / requests : 0,
      p50Ms: percentile(arr, 0.5),
      p95Ms: percentile(arr, 0.95),
      p99Ms: percentile(arr, 0.99),
    };
  });

  return { routes: routeResults, errors };
}

/** Median-aggregate `repeats` route results for one mode. */
function aggregate(mode: Mode, runs: Array<{ routes: RouteResult[]; errors: number }>): ModeResult {
  const perRoute = new Map<string, RouteResult[]>();
  for (const run of runs) {
    for (const r of run.routes) {
      const arr = perRoute.get(r.label) ?? [];
      arr.push(r);
      perRoute.set(r.label, arr);
    }
  }

  const med = (samples: RouteResult[], field: (r: RouteResult) => number): number =>
    median(samples.map(field));

  const routeResults: RouteResult[] = routes.map((spec) => {
    const samples = perRoute.get(spec.label) ?? [];
    return {
      label: spec.label,
      requests: med(samples, (r) => r.requests),
      rps: med(samples, (r) => r.rps),
      avgMs: med(samples, (r) => r.avgMs),
      p50Ms: med(samples, (r) => r.p50Ms),
      p95Ms: med(samples, (r) => r.p95Ms),
      p99Ms: med(samples, (r) => r.p99Ms),
    };
  });

  return {
    mode,
    warmupSec: WARMUP_S,
    durationSec: DURATION_S,
    repeats: runs.length,
    routes: routeResults,
    totalRequests: routeResults.reduce((a, r) => a + r.requests, 0),
    totalErrors: runs.reduce((a, run) => a + run.errors, 0),
  };
}

function buildComparison(reference: ModeResult, other: ModeResult): RouteComparison[] {
  const refMap = new Map(reference.routes.map((r) => [r.label, r]));
  const otherMap = new Map(other.routes.map((r) => [r.label, r]));

  return Array.from(refMap.keys()).map((label) => {
    const ref = refMap.get(label);
    const oth = otherMap.get(label);
    const referenceRps = ref?.rps ?? 0;
    const otherRps = oth?.rps ?? 0;
    const referenceP50 = ref?.p50Ms ?? 0;
    const otherP50 = oth?.p50Ms ?? 0;
    return {
      label,
      referenceMode: reference.mode,
      otherMode: other.mode,
      referenceRps,
      otherRps,
      rpsRatio: otherRps > 0 ? referenceRps / otherRps : Number.NaN,
      referenceP50Ms: referenceP50,
      otherP50Ms: otherP50,
      p50Ratio: otherP50 > 0 ? referenceP50 / otherP50 : Number.NaN,
    };
  });
}

function printSummary(m: ModeResult): void {
  console.log(
    `\n[${m.mode}] (median of ${m.repeats}) requests=${m.totalRequests} errors=${m.totalErrors}`,
  );
  for (const r of m.routes) {
    console.log(
      `  ${r.label.padEnd(22)} rps=${r.rps.toFixed(1).padStart(8)} p50=${r.p50Ms.toFixed(2).padStart(7)}ms p95=${r.p95Ms.toFixed(2).padStart(7)}ms p99=${r.p99Ms.toFixed(2).padStart(7)}ms`,
    );
  }
}

async function buildApp(): Promise<void> {
  console.log("building app (AOT)...");
  const proc = Bun.spawn(["bun", "builder.ts"], {
    cwd: APP_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`AOT build failed (exit ${code})`);
  }
}

/** Compare every mode against the raw-Bun reference (falls back to "native"). */
function buildComparisons(results: ModeResult[]): {
  referenceMode: Mode;
  comparison: RouteComparison[];
} {
  const referenceMode: Mode = results.some((r) => r.mode === "raw-bun") ? "raw-bun" : "native";
  const reference = results.find((r) => r.mode === referenceMode);
  const comparison: RouteComparison[] = [];
  if (reference) {
    for (const other of results) {
      if (other.mode === referenceMode) continue;
      comparison.push(...buildComparison(reference, other));
    }
  }
  return { referenceMode, comparison };
}

/** Print per-route comparisons grouped by the competing mode. */
function printComparisons(comparison: RouteComparison[], referenceMode: Mode): void {
  const byOther = new Map<Mode, RouteComparison[]>();
  for (const c of comparison) {
    const arr = byOther.get(c.otherMode) ?? [];
    arr.push(c);
    byOther.set(c.otherMode, arr);
  }
  for (const [otherMode, rows] of byOther) {
    console.log(
      `\n=== ${otherMode} vs ${referenceMode} (rps ratio; >1 = faster than ${referenceMode}) ===`,
    );
    console.log(
      `${"route".padEnd(34)} ${referenceMode}Rps  ${otherMode}Rps  ratio   ${referenceMode}P50  ${otherMode}P50`,
    );
    for (const c of rows) {
      const ratioText = Number.isFinite(c.rpsRatio) ? c.rpsRatio.toFixed(2) : "  n/a";
      const p50Text = Number.isFinite(c.p50Ratio) ? c.p50Ratio.toFixed(2) : "  n/a";
      console.log(
        `${c.label.padEnd(34)} ${c.referenceRps.toFixed(1).padStart(8)}  ${c.otherRps
          .toFixed(1)
          .padStart(9)}  ${ratioText.padStart(6)}   ${c.referenceP50Ms
          .toFixed(2)
          .padStart(8)}ms  ${c.otherP50Ms.toFixed(2).padStart(8)}ms  ${p50Text.padStart(6)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  if (!SKIP_BUILD) await buildApp();

  const ALL_MODES: Mode[] = ["native", "fallback", "raw-bun"];
  const resolveModes = (): Mode[] => {
    if (MODE === "native" || MODE === "fallback" || MODE === "raw-bun") {
      return [MODE as Mode];
    }
    if (MODE === "both") return ["native", "fallback"];
    return ALL_MODES;
  };
  const modes = resolveModes();
  const first = modes[0] ?? "native";

  console.log(
    `benchmarking ${routes.length} routes: duration=${DURATION_S}s warmup=${WARMUP_S}s concurrency=${CONCURRENCY} repeats=${REPEATS} modes=${modes.join(",")}`,
  );

  // Interleave: each repeat reverses the mode order to cancel order/drift.
  const byMode = new Map<Mode, Array<{ routes: RouteResult[]; errors: number }>>();
  for (const m of modes) byMode.set(m, []);

  for (let i = 0; i < REPEATS; i++) {
    const ordered = i % 2 === 0 ? modes : [...modes].reverse();
    for (const mode of ordered) {
      process.stdout.write(`repeat ${i + 1}/${REPEATS} mode=${mode} ... `);
      const run = await runOnce(mode);
      byMode.get(mode)?.push(run);
      process.stdout.write(`done (${run.routes.reduce((a, r) => a + r.requests, 0)} req)\n`);
    }
  }

  const results: ModeResult[] = modes.map((m) => aggregate(m, byMode.get(m) ?? []));
  for (const r of results) printSummary(r);

  const { referenceMode, comparison } = buildComparisons(results);

  const report: {
    generatedAt: string;
    bun: string;
    durationSec: number;
    warmupSec: number;
    concurrency: number;
    repeats: number;
    modeFirst: Mode;
    referenceMode: Mode;
    routes: string[];
    modes: ModeResult[];
    comparison?: RouteComparison[];
  } = {
    generatedAt: new Date().toISOString(),
    bun: process.versions.bun ?? "unknown",
    durationSec: DURATION_S,
    warmupSec: WARMUP_S,
    concurrency: CONCURRENCY,
    repeats: REPEATS,
    modeFirst: first,
    referenceMode,
    routes: routes.map((r) => r.label),
    modes: results,
    ...(comparison.length === 0 ? {} : { comparison }),
  };

  if (comparison.length > 0) {
    printComparisons(comparison, referenceMode);
  }

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(join(RESULTS_DIR, "latest.json"), JSON.stringify(report, null, 2));
  await writeFile(join(RESULTS_DIR, `${stamp}.json`), JSON.stringify(report, null, 2));
  console.log(`\nreport written to ${RESULTS_DIR}`);
}

await main();
