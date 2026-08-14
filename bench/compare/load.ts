/**
 * bench/compare/load.ts — weighted-flow HTTP load generator.
 *
 * Ported from the `bun-rust-runtime-bench` project's `bench/load.ts` so the
 * comparison bench uses the exact same methodology:
 *
 *  - scenario definitions with rate-paced phases (rps; `0` = idle, omitted =
 *    fire as fast as possible) and weighted flows,
 *  - a concurrency gate (`maxConcurrent` VUs in flight),
 *  - per-request latency histograms (avg/min/p50/p75/p90/p95/p99/p999/max),
 *  - outcome classification (success / expected_error / unexpected_status /
 *    timeout / network_error / shape_failure),
 *  - response-shape validation of every 2xx (`ok === true` + `requestId`
 *    string) — the wire-format contract,
 *  - per-server reports: `<scenario>.bench.json|md|html` + failures ndjson.
 *
 * Env:
 *   HTTP_NO_SHAPE=1   skip response-shape validation (pure throughput soak)
 *   DURATION_SCALE=n  multiply every phase duration (default 1) for quick runs
 */
import { mkdirSync, writeFileSync } from "node:fs";

const NO_SHAPE = (process.env.HTTP_NO_SHAPE ?? "").trim().toLowerCase() === "1";
const DURATION_SCALE = Math.max(0.01, Number(process.env.DURATION_SCALE ?? 1));

type Outcome =
  | "success"
  | "expected_error"
  | "unexpected_status"
  | "timeout"
  | "network_error"
  | "shape_failure";

interface LoadPhase {
  durationSec: number;
  /** Requests per second. 0 = idle phase; omitted = fire as fast as possible. */
  rate?: number;
  name?: string;
}

interface WeightedFlow {
  weight: number;
  fn: (ctx: FlowCtx) => Promise<void>;
}

interface LoadScenarioDef {
  name: string;
  phases: LoadPhase[];
  flows: WeightedFlow[];
  maxConcurrent?: number;
}

interface FlowCtx {
  base: string;
  server: string;
  scenario: string;
  phase: string;
  vu: number;
  iter: number;
  recorder: Recorder;
}

interface SendOpts {
  headers?: Record<string, string>;
  json?: unknown;
  body?: string;
  expected?: number[];
  requireShape?: boolean;
  timeoutMs?: number;
  routeTag?: string;
}

interface RecordInput {
  phase: string;
  vu: number;
  iter: number;
  method: string;
  route: string;
  url: string;
  status: number;
  latencyMs: number;
  outcome: Outcome;
  errorCode?: string;
  errorMessage?: string;
  responseSnippet?: string;
}

interface RequestTrace extends RecordInput {
  t: number;
  monoMs: number;
  server: string;
  scenario: string;
}

interface RouteStat {
  count: number;
  errors: number;
  durations: number[];
  statuses: Record<string, number>;
}

interface ErrorGroup {
  key: string;
  count: number;
  firstMonoMs: number;
  lastMonoMs: number;
  method: string;
  route: string;
  status: number;
  outcome: Outcome;
  errorCode: string;
  errorMessage: string;
  responseSnippet: string;
  samples: RequestTrace[];
}

// ── Random helpers ────────────────────────────────────────────────
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomString(len: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function pickOne<T>(arr: T[]): T {
  const item = arr[randomInt(0, arr.length - 1)];
  if (item === undefined) throw new Error("pickOne: empty array");
  return item;
}

function pickWeighted(items: WeightedFlow[]): WeightedFlow {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  const last = items[items.length - 1];
  if (last === undefined) throw new Error("pickWeighted: empty flows");
  return last;
}

function sleep(seconds: number): Promise<void> {
  return Bun.sleep(seconds * 1000);
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncate(value: unknown, max = 180): string {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── Recorder ──────────────────────────────────────────────────────
class Recorder {
  startWall = Date.now();
  startMono = Bun.nanoseconds();

  total = 0;
  success = 0;
  expectedErrors = 0;
  failed = 0;

  timeouts = 0;
  networkErrors = 0;
  unexpectedStatuses = 0;
  shapeFailures = 0;

  durationsAll: number[] = [];
  routeStats = new Map<string, RouteStat>();
  errorGroups = new Map<string, ErrorGroup>();
  failureSamples: RequestTrace[] = [];

  failureWriter: ReturnType<typeof Bun.file<string>>["writer"];

  constructor(
    public server: string,
    public scenario: string,
    public outDir: string,
    private maxFailureSamples = 250,
  ) {
    mkdirSync(outDir, { recursive: true });
    // Truncate the previous run's trace so this run's failures.ndjson contains
    // only the current run (Bun's FileSink appends otherwise).
    const tracePath = `${outDir}/${scenario}.failures.ndjson`;
    writeFileSync(tracePath, "");
    this.failureWriter = Bun.file(tracePath).writer();
  }

  record(input: RecordInput): void {
    const monoMs = (Bun.nanoseconds() - this.startMono) / 1_000_000;

    this.total++;
    this.durationsAll.push(input.latencyMs);

    const routeKey = `${input.method} ${input.route}`;
    let route = this.routeStats.get(routeKey);
    if (!route) {
      route = { count: 0, errors: 0, durations: [], statuses: {} };
      this.routeStats.set(routeKey, route);
    }
    route.count++;
    route.durations.push(input.latencyMs);
    const statusKey = String(input.status || 0);
    route.statuses[statusKey] = (route.statuses[statusKey] ?? 0) + 1;
    if (input.status === 0 || input.status >= 400) route.errors++;

    switch (input.outcome) {
      case "success":
        this.success++;
        break;
      case "expected_error":
        this.expectedErrors++;
        break;
      case "unexpected_status":
        this.failed++;
        this.unexpectedStatuses++;
        break;
      case "timeout":
        this.failed++;
        this.timeouts++;
        break;
      case "network_error":
        this.failed++;
        this.networkErrors++;
        break;
      case "shape_failure":
        this.failed++;
        this.shapeFailures++;
        break;
    }

    const isFailure = input.outcome !== "success" && input.outcome !== "expected_error";
    if (!isFailure) return;

    const trace: RequestTrace = {
      t: Date.now(),
      monoMs,
      server: this.server,
      scenario: this.scenario,
      phase: input.phase,
      vu: input.vu,
      iter: input.iter,
      method: input.method,
      route: input.route,
      url: input.url,
      status: input.status,
      latencyMs: input.latencyMs,
      outcome: input.outcome,
      errorCode: input.errorCode ?? "",
      errorMessage: input.errorMessage ?? "",
      responseSnippet: input.responseSnippet ?? "",
    };

    this.failureWriter.write(`${JSON.stringify(trace)}\n`);

    if (this.failureSamples.length < this.maxFailureSamples) {
      this.failureSamples.push(trace);
    }

    const groupKey = [
      input.method,
      input.route,
      String(input.status || 0),
      input.errorCode ?? "unknown",
      truncate(input.errorMessage ?? "", 160),
    ].join("|");

    let group = this.errorGroups.get(groupKey);
    if (!group) {
      group = {
        key: groupKey,
        count: 0,
        firstMonoMs: monoMs,
        lastMonoMs: monoMs,
        method: input.method,
        route: input.route,
        status: input.status,
        outcome: input.outcome,
        errorCode: input.errorCode ?? "",
        errorMessage: input.errorMessage ?? "",
        responseSnippet: input.responseSnippet ?? "",
        samples: [],
      };
      this.errorGroups.set(groupKey, group);
    }
    group.count++;
    group.lastMonoMs = monoMs;
    if (group.samples.length < 3) group.samples.push(trace);
  }

  recordUnhandled(ctx: FlowCtx, err: unknown): void {
    this.record({
      phase: ctx.phase,
      vu: ctx.vu,
      iter: ctx.iter,
      method: "FLOW",
      route: "/flow",
      url: ctx.base,
      status: 0,
      latencyMs: 0,
      outcome: "network_error",
      errorCode: "flow_exception",
      errorMessage: err instanceof Error ? err.message : String(err),
      responseSnippet: "",
    });
  }

  async end(): Promise<void> {
    await this.failureWriter.end();
  }
}

// ── send(): one request ───────────────────────────────────────────

/** Classify a completed response into an outcome + error metadata. */
function classifyOutcome(
  status: number,
  text: string,
  expected: number[],
  requireShape: boolean,
): { outcome: Outcome; errorCode: string; errorMessage: string } {
  const parsed = safeJson(text) as { error?: { code?: string; message?: string } } | null;

  if (!expected.includes(status)) {
    return {
      outcome: "unexpected_status",
      errorCode: parsed?.error?.code ?? "unexpected_status",
      errorMessage: parsed?.error?.message ?? `Unexpected status ${status}`,
    };
  }
  if (status >= 400) {
    return {
      outcome: "expected_error",
      errorCode: parsed?.error?.code ?? "expected_error",
      errorMessage: parsed?.error?.message ?? "Expected error response",
    };
  }
  if (requireShape && !NO_SHAPE) {
    const shape = safeJson(text) as { ok?: unknown; requestId?: unknown } | null;
    if (shape == null || shape.ok !== true || typeof shape.requestId !== "string") {
      return {
        outcome: "shape_failure",
        errorCode: "bad_response_shape",
        errorMessage: "Expected ok:true and requestId:string",
      };
    }
  }
  return { outcome: "success", errorCode: "", errorMessage: "" };
}

async function send(
  ctx: FlowCtx,
  method: string,
  path: string,
  opts: SendOpts = {},
): Promise<void> {
  const route = opts.routeTag ?? path.split("?")[0] ?? "";
  const url = ctx.base + path;

  const headers: Record<string, string> = {
    "X-Bench-Client": "bun-load",
    "X-Bench-Timestamp": String(Date.now()),
    ...opts.headers,
  };

  let body: string | undefined;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  } else if (opts.body !== undefined) {
    body = opts.body;
  }

  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const start = Bun.nanoseconds();

  let status = 0;
  let text = "";
  let outcome: Outcome = "network_error";
  let errorCode = "";
  let errorMessage = "";

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: "manual",
    });

    status = res.status;
    text = await res.text();
    const latencyMs = (Bun.nanoseconds() - start) / 1_000_000;
    const expected = opts.expected ?? [200];

    const classification = classifyOutcome(status, text, expected, opts.requireShape !== false);
    outcome = classification.outcome;
    errorCode = classification.errorCode;
    errorMessage = classification.errorMessage;

    ctx.recorder.record({
      phase: ctx.phase,
      vu: ctx.vu,
      iter: ctx.iter,
      method,
      route,
      url,
      status,
      latencyMs,
      outcome,
      errorCode,
      errorMessage,
      responseSnippet: outcome === "success" ? "" : truncate(text, 700),
    });
  } catch (err) {
    const latencyMs = (Bun.nanoseconds() - start) / 1_000_000;
    outcome = timedOut ? "timeout" : "network_error";
    errorCode = outcome;
    errorMessage = err instanceof Error ? err.message : String(err);
    ctx.recorder.record({
      phase: ctx.phase,
      vu: ctx.vu,
      iter: ctx.iter,
      method,
      route,
      url,
      status: 0,
      latencyMs,
      outcome,
      errorCode,
      errorMessage,
      responseSnippet: "",
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── stats / reports ───────────────────────────────────────────────
function stats(durations: number[]) {
  if (durations.length === 0) {
    return { count: 0, avg: 0, min: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, p999: 0, max: 0 };
  }
  durations.sort((a, b) => a - b);
  const sum = durations.reduce((a, b) => a + b, 0);
  const at = (p: number) =>
    durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))];
  return {
    count: durations.length,
    avg: sum / durations.length,
    min: durations[0],
    p50: at(50),
    p75: at(75),
    p90: at(90),
    p95: at(95),
    p99: at(99),
    p999: at(99.9),
    max: durations[durations.length - 1],
  };
}

function fmtMs(n: number): string {
  return Number.isFinite(n) ? n.toFixed(3) : "0.000";
}
function fmtPct(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}
function mdEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}
function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function mdTable(headers: string[], rows: unknown[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(mdEscape).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}
function htmlTable(headers: string[], rows: unknown[][]): string {
  const head = `<tr>${headers.map((h) => `<th>${htmlEscape(h)}</th>`).join("")}</tr>`;
  const body = rows
    .map((row) => `<tr>${row.map((c) => `<td>${htmlEscape(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

interface BenchReport {
  server: string;
  scenario: string;
  generatedAt: string;
  totalDurationMs: number;
  achievedRps: number;
  totalRequests: number;
  success: number;
  expectedErrors: number;
  failed: number;
  timeouts: number;
  networkErrors: number;
  unexpectedStatuses: number;
  shapeFailures: number;
  errorRatePct: number;
  global: ReturnType<typeof stats>;
  routes: Array<Record<string, number | string | Record<string, number>>>;
  errorGroups: ErrorGroup[];
  failureSamples: RequestTrace[];
}

function overviewRows(report: BenchReport): unknown[][] {
  return [
    ["Server", report.server],
    ["Scenario", report.scenario],
    ["Generated", report.generatedAt],
    ["Total duration ms", fmtMs(report.totalDurationMs)],
    ["Achieved RPS", report.achievedRps.toFixed(2)],
    ["Total requests", report.totalRequests],
    ["Successful requests", report.success],
    ["Expected error responses", report.expectedErrors],
    ["Unexpected failed requests", report.failed],
    ["Timeouts", report.timeouts],
    ["Network errors", report.networkErrors],
    ["Unexpected statuses", report.unexpectedStatuses],
    ["Response shape failures", report.shapeFailures],
    ["Unexpected error rate %", fmtPct(report.errorRatePct)],
    ["Avg latency ms", fmtMs(report.global.avg)],
    ["Min latency ms", fmtMs(report.global.min)],
    ["p50 latency ms", fmtMs(report.global.p50)],
    ["p75 latency ms", fmtMs(report.global.p75)],
    ["p90 latency ms", fmtMs(report.global.p90)],
    ["p95 latency ms", fmtMs(report.global.p95)],
    ["p99 latency ms", fmtMs(report.global.p99)],
    ["p99.9 latency ms", fmtMs(report.global.p999)],
    ["Max latency ms", fmtMs(report.global.max)],
  ];
}

function routeRows(report: BenchReport): unknown[][] {
  return report.routes.map((r) => [
    r.name,
    r.count,
    r.errors,
    fmtPct(r.errorPct as number),
    fmtMs(r.min as number),
    fmtMs(r.avg as number),
    fmtMs(r.p50 as number),
    fmtMs(r.p95 as number),
    fmtMs(r.p99 as number),
    fmtMs(r.p999 as number),
    fmtMs(r.max as number),
  ]);
}

function errorGroupRows(report: BenchReport): unknown[][] {
  return report.errorGroups
    .slice(0, 100)
    .map((g) => [
      g.count,
      g.method,
      g.route,
      g.status,
      g.errorCode,
      truncate(g.errorMessage, 140),
      fmtMs(g.firstMonoMs),
      fmtMs(g.lastMonoMs),
      truncate(g.responseSnippet, 140),
    ]);
}

function failureRows(report: BenchReport): unknown[][] {
  return report.failureSamples
    .slice(0, 75)
    .map((f) => [
      fmtMs(f.monoMs),
      f.vu,
      f.iter,
      f.method,
      f.route,
      f.status,
      fmtMs(f.latencyMs),
      f.errorCode,
      truncate(f.errorMessage, 120),
      truncate(f.responseSnippet, 120),
    ]);
}

function toMarkdown(report: BenchReport): string {
  const md = `# Ignus HTTP comparison report — ${report.server} / ${report.scenario}

Generated: ${report.generatedAt}

Failure trace: \`${report.scenario}.failures.ndjson\`

## Overview

${mdTable(["Metric", "Value"], overviewRows(report))}

## Error groups

These are unexpected failures. This table tells you which request failed and why.

${mdTable(
  [
    "Count",
    "Method",
    "Route",
    "Status",
    "Error code",
    "Error message",
    "First ms",
    "Last ms",
    "Sample response",
  ],
  errorGroupRows(report),
)}

## Route latency

${mdTable(
  [
    "Route",
    "Count",
    "Errors",
    "Error %",
    "Min ms",
    "Avg ms",
    "p50 ms",
    "p95 ms",
    "p99 ms",
    "p99.9 ms",
    "Max ms",
  ],
  routeRows(report),
)}

## Failure samples

${mdTable(
  [
    "Time ms",
    "VU",
    "Iter",
    "Method",
    "Route",
    "Status",
    "Latency ms",
    "Error code",
    "Error message",
    "Response snippet",
  ],
  failureRows(report),
)}
`;
  return md;
}

function toHtml(report: BenchReport): string {
  const esc = htmlEscape;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Ignus HTTP comparison report — ${esc(report.server)} / ${esc(report.scenario)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; color: #111; }
  h1, h2 { margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 32px; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; font-size: 13px; vertical-align: top; }
  th { background: #f6f6f6; text-align: left; }
  tr:nth-child(even) td { background: #fafafa; }
  code { background: #f6f6f6; padding: 2px 4px; border-radius: 4px; }
</style>
</head>
<body>
<h1>Ignus HTTP comparison report — ${esc(report.server)} / ${esc(report.scenario)}</h1>
<p>Generated: ${esc(report.generatedAt)}</p>
<p>Failure trace: <code>${esc(report.scenario)}.failures.ndjson</code></p>

<h2>Overview</h2>
${htmlTable(["Metric", "Value"], overviewRows(report))}

<h2>Error groups</h2>
${htmlTable(
  [
    "Count",
    "Method",
    "Route",
    "Status",
    "Error code",
    "Error message",
    "First ms",
    "Last ms",
    "Sample response",
  ],
  errorGroupRows(report),
)}

<h2>Route latency</h2>
${htmlTable(
  [
    "Route",
    "Count",
    "Errors",
    "Error %",
    "Min ms",
    "Avg ms",
    "p50 ms",
    "p95 ms",
    "p99 ms",
    "p99.9 ms",
    "Max ms",
  ],
  routeRows(report),
)}

<h2>Failure samples</h2>
${htmlTable(
  [
    "Time ms",
    "VU",
    "Iter",
    "Method",
    "Route",
    "Status",
    "Latency ms",
    "Error code",
    "Error message",
    "Response snippet",
  ],
  failureRows(report),
)}
</body>
</html>
`;
}

function buildReport(recorder: Recorder): BenchReport {
  const totalDurationMs = (Bun.nanoseconds() - recorder.startMono) / 1_000_000;
  const global = stats(recorder.durationsAll);

  const routes = [...recorder.routeStats.entries()]
    .map(([name, s]) => {
      const st = stats(s.durations);
      return {
        name,
        count: s.count,
        errors: s.errors,
        statuses: s.statuses,
        errorPct: s.count ? (s.errors / s.count) * 100 : 0,
        avg: st.avg,
        min: st.min,
        p50: st.p50,
        p75: st.p75,
        p90: st.p90,
        p95: st.p95,
        p99: st.p99,
        p999: st.p999,
        max: st.max,
      };
    })
    .sort((a, b) => (b.p95 as number) - (a.p95 as number) || b.count - a.count);

  const errorGroups = [...recorder.errorGroups.values()].sort((a, b) => b.count - a.count);

  return {
    server: recorder.server,
    scenario: recorder.scenario,
    generatedAt: new Date().toISOString(),
    totalDurationMs,
    achievedRps: recorder.total / Math.max(totalDurationMs / 1000, 1e-9),
    totalRequests: recorder.total,
    success: recorder.success,
    expectedErrors: recorder.expectedErrors,
    failed: recorder.failed,
    timeouts: recorder.timeouts,
    networkErrors: recorder.networkErrors,
    unexpectedStatuses: recorder.unexpectedStatuses,
    shapeFailures: recorder.shapeFailures,
    errorRatePct: recorder.total ? (recorder.failed / recorder.total) * 100 : 0,
    global,
    routes,
    errorGroups,
    failureSamples: recorder.failureSamples,
  };
}

async function writeReports(report: BenchReport, outDir: string, scenario: string): Promise<void> {
  await Bun.write(`${outDir}/${scenario}.bench.json`, JSON.stringify(report, null, 2));
  await Bun.write(`${outDir}/${scenario}.bench.md`, toMarkdown(report));
  await Bun.write(`${outDir}/${scenario}.bench.html`, toHtml(report));

  console.log(`  report: ${outDir}/${scenario}.bench.md`);
  console.log(`  html:   ${outDir}/${scenario}.bench.html`);
  console.log(`  json:   ${outDir}/${scenario}.bench.json`);
  console.log(`  trace:  ${outDir}/${scenario}.failures.ndjson`);
}

// ── executeScenario: paced scheduling + concurrency gate ──────────
async function executeScenario(
  def: LoadScenarioDef,
  env: { server: string; port: number; recorder: Recorder },
): Promise<void> {
  const base = `http://localhost:${env.port}`;
  const active = new Set<Promise<void>>();
  let vuSeq = 0;
  let iterSeq = 0;
  const maxConcurrent = def.maxConcurrent ?? 2000;

  async function launch(phaseName: string): Promise<void> {
    while (active.size >= maxConcurrent) {
      await Promise.race(active);
    }
    const vu = ++vuSeq;
    const iter = ++iterSeq;
    const ctx: FlowCtx = {
      base,
      server: env.server,
      scenario: def.name,
      phase: phaseName,
      vu,
      iter,
      recorder: env.recorder,
    };
    const flow = pickWeighted(def.flows).fn;
    let p: Promise<void> | undefined;
    const tracked = (async () => {
      try {
        await flow(ctx);
      } catch (err) {
        env.recorder.recordUnhandled(ctx, err);
      } finally {
        if (p) active.delete(p);
      }
    })();
    p = tracked;
    active.add(p);
  }

  for (const phase of def.phases) {
    const durationNs = phase.durationSec * DURATION_SCALE * 1_000_000_000;
    const rate = phase.rate;
    if (rate !== undefined && rate <= 0) {
      await Bun.sleep(phase.durationSec * DURATION_SCALE * 1000);
      continue;
    }
    const intervalNs = rate === undefined ? 0 : 1_000_000_000 / rate;
    let phaseStart = Bun.nanoseconds();
    let next = phaseStart;
    let i = 0;
    const phaseEnd = phaseStart + durationNs;

    while (Bun.nanoseconds() < phaseEnd) {
      const now = Bun.nanoseconds();
      if (now < next) {
        const delayMs = (next - now) / 1_000_000;
        if (delayMs > 1.5) {
          await Bun.sleep(delayMs - 1);
        } else if (delayMs > 0) {
          await Bun.sleep(delayMs);
        }
      }
      await launch(phase.name ?? "phase");
      i++;
      next = phaseStart + intervalNs * i;
      const now2 = Bun.nanoseconds();
      if (next < now2 - intervalNs * 50) {
        phaseStart = now2;
        i = 0;
        next = now2;
      }
    }
  }

  await Promise.allSettled(active);
}

export async function runHttpScenario(opts: {
  scenario: string;
  server: string;
  port: number;
  outDir?: string;
}): Promise<void> {
  const def = HTTP_SCENARIOS[opts.scenario];
  if (!def) {
    throw new Error(
      `Unknown scenario: ${opts.scenario}. Valid scenarios: ${HTTP_SCENARIO_NAMES.join(", ")}`,
    );
  }
  const outDir = opts.outDir ?? `./bench/results/compare/${opts.server}`;
  const recorder = new Recorder(opts.server, opts.scenario, outDir);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${opts.server.toUpperCase()}  ×  ${opts.scenario}`);
  console.log(`${"═".repeat(60)}`);

  await executeScenario(def, { server: opts.server, port: opts.port, recorder });
  await recorder.end();
  const report = buildReport(recorder);
  await writeReports(report, outDir, opts.scenario);
}

// ── Scenario helpers ──────────────────────────────────────────────
function manyCookies(count: number): string {
  return Array.from({ length: count }, (_, i) => `c${i}=v${i}`).join("; ");
}

function randomUser() {
  return { id: randomInt(1, 999999), name: `user_${randomString(8)}`, active: true };
}

function largePayloadBytes(bytes: number): string {
  return "x".repeat(bytes);
}

function largeJsonArray(count = 5000): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      data: "x".repeat(100),
    })),
  );
}

async function health(
  ctx: FlowCtx,
  expected: number[] = [200],
  headers: Record<string, string> = {},
) {
  await send(ctx, "GET", "/health", { expected, headers });
}

async function getUsers(
  ctx: FlowCtx,
  expected: number[] = [200],
  query = "",
  headers: Record<string, string> = {},
) {
  await send(ctx, "GET", `/api/users${query}`, {
    routeTag: "/api/users",
    expected,
    headers,
  });
}

async function postUser(
  ctx: FlowCtx,
  body: unknown,
  expected: number[] = [200],
  headers: Record<string, string> = {},
) {
  await send(ctx, "POST", "/api/users", { json: body, expected, headers });
}

async function postRaw(
  ctx: FlowCtx,
  body: string,
  contentType: string,
  expected: number[] = [200],
  route = "/api/users",
  routeTag = "/api/users",
) {
  await send(ctx, "POST", route, {
    body,
    headers: { "Content-Type": contentType },
    expected,
    routeTag,
    requireShape: false,
  });
}

async function echoRaw(
  ctx: FlowCtx,
  body: string,
  contentType: string,
  expected: number[] = [200],
) {
  await send(ctx, "POST", "/api/echo", {
    body,
    headers: { "Content-Type": contentType },
    expected,
    routeTag: "/api/echo",
    requireShape: false,
  });
}

async function cookiesRoute(ctx: FlowCtx, expected: number[] = [200], cookie: string) {
  await send(ctx, "GET", "/api/cookies", { expected, headers: { Cookie: cookie } });
}

async function preflight(ctx: FlowCtx, origin: string, expected: number[] = [204]) {
  await send(ctx, "OPTIONS", "/api/users", {
    expected,
    requireShape: false,
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type, Authorization",
    },
  });
}

function rampPhases(
  from: number,
  to: number,
  totalSec: number,
  stepSec = 5,
  name = "Ramp",
): LoadPhase[] {
  const steps = Math.max(1, Math.floor(totalSec / stepSec));
  const phases: LoadPhase[] = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const rate = Math.round(from + (to - from) * t);
    phases.push({ durationSec: stepSec, rate, name: `${name} ${rate} rps` });
  }
  return phases;
}

// ── Heavy JSON payload helpers ────────────────────────────────────
/**
 * Schema-valid heavy payload. The contract schema (USER_SCHEMA) allows only
 * id/name/email/active/tags with `additionalProperties: false`, so the payload
 * must stay within those fields for ALL THREE servers to accept it (Elysia
 * would accept extra fields while raw Bun/ignex reject them — see the rust
 * project's own 13-heavy-json-nested results, which fail on bun/ingress for
 * exactly this reason). `depth` scales the field sizes so the body stays heavy
 * under validation.
 */
function complexUserPayload(depth: number = 3): unknown {
  const tagLen = 24 * depth; // deeper → longer tags → heavier body
  return {
    id: randomInt(1, 999999),
    name: `user_${randomString(Math.min(32, tagLen))}`,
    email: `${randomString(8)}@${randomString(Math.min(16, tagLen / 2))}.example.com`,
    active: Math.random() > 0.3,
    tags: Array.from({ length: 20 }, () => randomString(tagLen)),
  };
}

function widePayload(fieldCount: number): unknown {
  const obj: Record<string, unknown> = {
    id: randomInt(1, 999999),
    name: `wide_${randomString(8)}`,
  };
  for (let i = 0; i < fieldCount; i++) {
    obj[`field_${i}`] = {
      value: randomString(20),
      index: i,
      active: Math.random() > 0.5,
      score: Math.random() * 100,
    };
  }
  return obj;
}

// ── HTTP scenarios ────────────────────────────────────────────────
export const HTTP_SCENARIOS: Record<string, LoadScenarioDef> = {
  "01-smoke": {
    name: "01-smoke",
    maxConcurrent: 50,
    phases: [{ durationSec: 10, rate: 5, name: "Smoke" }],
    flows: [
      {
        weight: 1,
        fn: async (ctx) => {
          await health(ctx);
        },
      },
      {
        weight: 1,
        fn: async (ctx) => {
          await getUsers(ctx, [200], "?limit=10&offset=0&sort=name", {
            Cookie: "sid=abc123; theme=dark; lang=en-US",
          });
        },
      },
      {
        weight: 1,
        fn: async (ctx) => {
          await postUser(ctx, {
            id: 42,
            name: "alice",
            email: "alice@example.com",
            active: true,
            tags: ["admin"],
          });
        },
      },
    ],
  },

  "02-load": {
    name: "02-load",
    maxConcurrent: 1000,
    phases: [
      { durationSec: 30, rate: 50, name: "Warm up" },
      { durationSec: 60, rate: 200, name: "Sustained load" },
      { durationSec: 30, rate: 50, name: "Cool down" },
    ],
    flows: [
      {
        weight: 70,
        fn: async (ctx) => {
          await getUsers(ctx, [200], `?page=${randomInt(1, 100)}&limit=20`, {
            Cookie: `sid=session_${randomString(16)}`,
          });
          await sleep(0.5);
          await postUser(ctx, randomUser());
        },
      },
      {
        weight: 20,
        fn: async (ctx) => {
          await health(ctx);
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          await cookiesRoute(ctx, [200], manyCookies(20));
        },
      },
    ],
  },

  "03-stress": {
    name: "03-stress",
    maxConcurrent: 10000,
    phases: [
      { durationSec: 20, rate: 100, name: "Ramp 1" },
      { durationSec: 20, rate: 500, name: "Ramp 2" },
      { durationSec: 20, rate: 1000, name: "Ramp 3" },
      { durationSec: 20, rate: 2000, name: "Ramp 4" },
      { durationSec: 20, name: "Max" },
    ],
    flows: [
      {
        weight: 50,
        fn: async (ctx) => {
          await getUsers(ctx, [200], `?q=${randomString(20)}&page=${randomInt(1, 50)}`);
        },
      },
      {
        weight: 30,
        fn: async (ctx) => {
          await postUser(ctx, {
            id: randomInt(1, 999999),
            name: `stress_${randomString(12)}`,
          });
        },
      },
      {
        weight: 20,
        fn: async (ctx) => {
          await health(ctx);
        },
      },
    ],
  },

  "04-spike": {
    name: "04-spike",
    maxConcurrent: 8000,
    phases: [
      { durationSec: 30, rate: 20, name: "Baseline" },
      { durationSec: 5, rate: 3000, name: "SPIKE" },
      { durationSec: 30, rate: 20, name: "Recovery" },
      { durationSec: 5, rate: 5000, name: "SPIKE 2" },
      { durationSec: 30, rate: 20, name: "Recovery 2" },
    ],
    flows: [
      {
        weight: 1,
        fn: async (ctx) => {
          await getUsers(ctx, [200], "?spike=true");
          await postUser(ctx, {
            id: randomInt(1, 999999),
            name: `spike_${randomString(6)}`,
          });
        },
      },
    ],
  },

  "05-soak": {
    name: "05-soak",
    maxConcurrent: 1000,
    phases: [{ durationSec: 600, rate: 100, name: "10 minute soak" }],
    flows: [
      {
        weight: 1,
        fn: async (ctx) => {
          await getUsers(ctx, [200], `?soak=1&page=${randomInt(1, 100)}`, {
            Cookie: `sid=soak_${randomString(8)}`,
          });
          await sleep(1);
          await postUser(ctx, {
            id: randomInt(1, 999999),
            name: `soak_${randomString(10)}`,
          });
          await sleep(1);
        },
      },
    ],
  },

  "06-edge-cases": {
    name: "06-edge-cases",
    maxConcurrent: 200,
    phases: [{ durationSec: 30, rate: 20, name: "Edge cases" }],
    flows: [
      {
        weight: 10,
        fn: async (ctx) => {
          await postRaw(ctx, "{invalid json!!!", "application/json", [400]);
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          await postUser(ctx, { email: "nobody@example.com" }, [422]);
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          // Unknown fields: raw Bun and ignex reject (422, additionalProperties:
          // false); Elysia accepts and echoes them (200).
          await postUser(ctx, { id: 1, name: "test", admin: true, role: "superuser" }, [200, 422]);
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          // Content-type guard: raw Bun and ignex return 415; Elysia's typed
          // route returns 422 (its native "validation failed" for a
          // non-JSON body) — both are valid rejections of this request.
          await postRaw(ctx, "id=1&name=test", "text/plain", [415, 422]);
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          // Empty body on a typed route: raw Bun and ignex return 400;
          // Elysia returns 422 (validation error).
          await send(ctx, "POST", "/api/users", {
            body: "",
            headers: { "Content-Type": "application/json" },
            expected: [400, 422],
            requireShape: false,
          });
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          await send(ctx, "GET", "/api/nonexistent", {
            expected: [404],
            requireShape: false,
            routeTag: "/api/nonexistent",
          });
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          await getUsers(ctx, [200, 414], `?${randomString(2000)}=value`);
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          await cookiesRoute(ctx, [200], manyCookies(50));
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          await postUser(ctx, { id: 999, name: "日本語テスト_🚀_ünïcödé" });
        },
      },
      {
        weight: 5,
        fn: async (ctx) => {
          await send(ctx, "HEAD", "/health", { expected: [200], requireShape: false });
        },
      },
      {
        weight: 5,
        fn: async (ctx) => {
          await send(ctx, "DELETE", "/api/users", {
            expected: [404, 405],
            requireShape: false,
          });
        },
      },
    ],
  },

  "07-cors-preflight": {
    name: "07-cors-preflight",
    maxConcurrent: 500,
    phases: [{ durationSec: 30, rate: 100, name: "CORS preflight storm" }],
    flows: [
      {
        weight: 60,
        fn: async (ctx) => {
          await preflight(ctx, "https://app.example.com", [204]);
        },
      },
      {
        weight: 20,
        fn: async (ctx) => {
          await preflight(ctx, "https://evil.example.com", [204, 403]);
        },
      },
      {
        weight: 20,
        fn: async (ctx) => {
          await postUser(ctx, { id: 1, name: "cors_test" }, [200], {
            Origin: "https://app.example.com",
          });
        },
      },
    ],
  },

  "09-large-payload": {
    name: "09-large-payload",
    maxConcurrent: 100,
    phases: [{ durationSec: 30, rate: 10, name: "Large payloads" }],
    flows: [
      {
        weight: 50,
        fn: async (ctx) => {
          const size = pickOne([16 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024]);
          await echoRaw(ctx, largePayloadBytes(size), "application/octet-stream");
        },
      },
      {
        weight: 50,
        fn: async (ctx) => {
          await echoRaw(ctx, largeJsonArray(5000), "application/json");
        },
      },
    ],
  },

  "10-mixed-realistic": {
    name: "10-mixed-realistic",
    maxConcurrent: 5000,
    phases: rampPhases(100, 300, 60, 5, "Realistic"),
    flows: [
      {
        weight: 50,
        fn: async (ctx) => {
          const origin = pickOne(["https://app.example.com", "https://admin.example.com"]);
          await health(ctx, [200], { Origin: origin });
          await sleep(0.2);
          await getUsers(ctx, [200], `?page=${randomInt(1, 20)}&limit=20&sort=created_at`, {
            Origin: origin,
            Cookie: `sid=${randomString(32)}; theme=dark`,
          });
          await sleep(0.5);
          await postUser(
            ctx,
            {
              id: randomInt(1, 999999),
              name: `user_${randomString(8)}`,
              email: `user_${randomString(4)}@example.com`,
              active: true,
            },
            [200],
            { Origin: origin, Cookie: `sid=${randomString(32)}` },
          );
          await sleep(0.3);
        },
      },
      {
        weight: 30,
        fn: async (ctx) => {
          for (const offset of [0, 50, 100, 150, 200]) {
            await getUsers(ctx, [200], `?offset=${offset}&limit=50`, {
              Authorization: `Bearer token_${randomString(16)}`,
            });
          }
        },
      },
      {
        weight: 20,
        fn: async (ctx) => {
          await getUsers(ctx, [200], "?limit=5");
          await sleep(2);
          await postUser(ctx, {
            id: randomInt(1, 999999),
            name: `mobile_${randomString(6)}`,
          });
          await sleep(3);
        },
      },
    ],
  },

  "11-concurrent-burst": {
    name: "11-concurrent-burst",
    maxConcurrent: 8000,
    phases: [
      { durationSec: 5, rate: 1000, name: "Burst 1" },
      { durationSec: 10, rate: 10, name: "Pause" },
      { durationSec: 5, rate: 2000, name: "Burst 2" },
      { durationSec: 10, rate: 10, name: "Pause" },
      { durationSec: 5, rate: 3000, name: "Burst 3" },
    ],
    flows: [
      {
        weight: 60,
        fn: async (ctx) => {
          await getUsers(ctx, [200], "?burst=1");
        },
      },
      {
        weight: 40,
        fn: async (ctx) => {
          await postUser(ctx, {
            id: randomInt(1, 999999),
            name: `burst_${randomString(6)}`,
          });
        },
      },
    ],
  },

  "13-heavy-json-nested": {
    name: "13-heavy-json-nested",
    maxConcurrent: 500,
    phases: [
      { durationSec: 15, rate: 50, name: "Warm up" },
      { durationSec: 30, rate: 200, name: "Sustained nested" },
      { durationSec: 15, rate: 50, name: "Cool down" },
    ],
    flows: [
      {
        weight: 70,
        fn: async (ctx) => {
          await postUser(ctx, complexUserPayload(3), [200]);
        },
      },
      {
        weight: 20,
        fn: async (ctx) => {
          await postUser(ctx, complexUserPayload(5), [200]);
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          const bad = complexUserPayload(2) as Record<string, unknown>;
          bad.id = "not-a-number";
          bad.name = "";
          await postUser(ctx, bad, [422]);
        },
      },
    ],
  },

  "14-heavy-json-arrays": {
    name: "14-heavy-json-arrays",
    maxConcurrent: 300,
    phases: [
      { durationSec: 10, rate: 30, name: "Warm up" },
      { durationSec: 30, rate: 100, name: "Sustained arrays" },
      { durationSec: 10, rate: 30, name: "Cool down" },
    ],
    flows: [
      {
        weight: 50,
        fn: async (ctx) => {
          await postUser(
            ctx,
            {
              id: randomInt(1, 999999),
              name: `array_${randomString(10)}`,
              tags: Array.from({ length: 20 }, () => randomString(32)),
            },
            [200],
          );
        },
      },
      {
        weight: 30,
        fn: async (ctx) => {
          await echoRaw(
            ctx,
            JSON.stringify(
              Array.from({ length: 1000 }, (_, i) => ({
                id: i,
                name: `row_${i}`,
                data: randomString(64),
                nested: { a: 1, b: [1, 2, 3], c: { d: true } },
              })),
            ),
            "application/json",
          );
        },
      },
      {
        weight: 20,
        fn: async (ctx) => {
          await postUser(
            ctx,
            {
              id: randomInt(1, 999999),
              name: "too_many_tags",
              tags: Array.from({ length: 25 }, () => randomString(10)),
            },
            [422],
          );
        },
      },
    ],
  },

  "15-heavy-json-wide": {
    name: "15-heavy-json-wide",
    maxConcurrent: 400,
    phases: [
      { durationSec: 10, rate: 40, name: "Warm up" },
      { durationSec: 30, rate: 150, name: "Sustained wide" },
      { durationSec: 10, rate: 40, name: "Cool down" },
    ],
    flows: [
      {
        weight: 60,
        fn: async (ctx) => {
          // Wide payload with unknown fields: raw Bun and ignex reject (422);
          // Elysia accepts extra fields (200).
          await postUser(ctx, widePayload(50), [200, 422]);
        },
      },
      {
        weight: 30,
        fn: async (ctx) => {
          await postUser(
            ctx,
            { id: randomInt(1, 999999), name: `control_${randomString(8)}` },
            [200],
          );
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          await echoRaw(ctx, JSON.stringify(widePayload(100)), "application/json");
        },
      },
    ],
  },

  "16-crud-validation-mix": {
    name: "16-crud-validation-mix",
    maxConcurrent: 2000,
    phases: [
      { durationSec: 20, rate: 100, name: "Ramp 1" },
      { durationSec: 40, rate: 300, name: "Sustained CRUD" },
      { durationSec: 20, rate: 500, name: "Peak" },
      { durationSec: 20, rate: 100, name: "Cool down" },
    ],
    flows: [
      {
        weight: 40,
        fn: async (ctx) => {
          await getUsers(
            ctx,
            [200],
            `?page=${randomInt(1, 50)}&limit=20&sort=created_at&filter=${randomString(10)}`,
            { Cookie: `sid=${randomString(32)}; prefs=${randomString(16)}` },
          );
        },
      },
      {
        weight: 25,
        fn: async (ctx) => {
          await postUser(ctx, {
            id: randomInt(1, 999999),
            name: `crud_${randomString(10)}`,
            email: `${randomString(6)}@example.com`,
            active: true,
            tags: ["alpha", "beta"],
          });
        },
      },
      {
        weight: 15,
        fn: async (ctx) => {
          await send(ctx, "PUT", "/api/users", {
            json: {
              id: randomInt(1, 999999),
              name: `updated_${randomString(8)}`,
              email: `${randomString(8)}@corp.io`,
              active: false,
              tags: ["updated"],
            },
            expected: [200],
          });
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          await send(ctx, "PATCH", "/api/users", {
            json: {
              id: randomInt(1, 999999),
              name: `patched_${randomString(6)}`,
            },
            expected: [200],
          });
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          await postUser(ctx, { name: "missing_id_field" }, [422]);
        },
      },
    ],
  },

  "17-json-validation-spike": {
    name: "17-json-validation-spike",
    maxConcurrent: 5000,
    phases: [
      { durationSec: 15, rate: 50, name: "Baseline" },
      { durationSec: 5, rate: 2000, name: "SPIKE" },
      { durationSec: 20, rate: 50, name: "Recovery" },
      { durationSec: 5, rate: 3000, name: "SPIKE 2" },
      { durationSec: 20, rate: 50, name: "Recovery 2" },
    ],
    flows: [
      {
        weight: 50,
        fn: async (ctx) => {
          await postUser(ctx, {
            id: randomInt(1, 999999),
            name: `spike_${randomString(10)}`,
            email: `${randomString(5)}@test.dev`,
            active: Math.random() > 0.5,
            tags: Array.from({ length: 5 }, () => randomString(4)),
          });
        },
      },
      {
        weight: 30,
        fn: async (ctx) => {
          await getUsers(ctx, [200], `?q=${randomString(20)}`);
        },
      },
      {
        weight: 20,
        fn: async (ctx) => {
          await health(ctx);
        },
      },
    ],
  },

  "18-json-validation-soak": {
    name: "18-json-validation-soak",
    maxConcurrent: 800,
    phases: [{ durationSec: 300, rate: 150, name: "5 minute validation soak" }],
    flows: [
      {
        weight: 40,
        fn: async (ctx) => {
          await postUser(ctx, {
            id: randomInt(1, 999999),
            name: `soak_${randomString(12)}`,
            email: `${randomString(8)}@soak.example.com`,
            active: true,
            tags: ["soak", "test"],
          });
          await sleep(0.5);
        },
      },
      {
        weight: 30,
        fn: async (ctx) => {
          await getUsers(ctx, [200], `?page=${randomInt(1, 100)}&limit=50`, {
            Cookie: `session=${randomString(24)}`,
          });
          await sleep(0.3);
        },
      },
      {
        weight: 20,
        fn: async (ctx) => {
          await cookiesRoute(ctx, [200], manyCookies(15));
          await sleep(0.2);
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          await postUser(ctx, { id: "invalid", name: 12345 }, [422]);
          await sleep(1);
        },
      },
    ],
  },

  "19-large-body-boundary": {
    name: "19-large-body-boundary",
    maxConcurrent: 200,
    phases: [{ durationSec: 30, rate: 20, name: "Boundary test" }],
    flows: [
      {
        weight: 30,
        fn: async (ctx) => {
          const payload = JSON.stringify({
            id: randomInt(1, 999999),
            data: "x".repeat(64 * 1024),
          });
          await echoRaw(ctx, payload, "application/json");
        },
      },
      {
        weight: 30,
        fn: async (ctx) => {
          const payload = JSON.stringify({
            id: randomInt(1, 999999),
            rows: Array.from({ length: 2000 }, (_, i) => ({
              id: i,
              value: randomString(100),
            })),
          });
          await echoRaw(ctx, payload, "application/json");
        },
      },
      {
        weight: 20,
        fn: async (ctx) => {
          await echoRaw(ctx, largePayloadBytes(1024 * 1024), "application/octet-stream");
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          await postUser(ctx, {
            id: randomInt(1, 999999),
            name: `boundary_${randomString(6)}`,
          });
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          await postUser(ctx, {
            id: randomInt(1, 999999),
            name: "a".repeat(256),
          });
        },
      },
    ],
  },

  "20-validation-storm": {
    name: "20-validation-storm",
    maxConcurrent: 6000,
    phases: [
      { durationSec: 10, rate: 200, name: "Ramp" },
      { durationSec: 30, rate: 800, name: "Storm" },
      { durationSec: 10, rate: 100, name: "Recovery" },
    ],
    flows: [
      {
        weight: 25,
        fn: async (ctx) => {
          await postUser(ctx, {
            id: randomInt(1, 999999),
            name: `storm_${randomString(8)}`,
          });
        },
      },
      {
        weight: 20,
        fn: async (ctx) => {
          await send(ctx, "PUT", "/api/users", {
            json: { id: randomInt(1, 999999), name: `put_${randomString(8)}`, active: true },
            expected: [200],
          });
        },
      },
      {
        weight: 20,
        fn: async (ctx) => {
          await send(ctx, "PATCH", "/api/users", {
            json: { id: randomInt(1, 999999), name: `patch_${randomString(6)}` },
            expected: [200],
          });
        },
      },
      {
        weight: 15,
        fn: async (ctx) => {
          await getUsers(ctx, [200], `?storm=${randomString(10)}`);
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          await postUser(ctx, { invalid: true }, [422]);
        },
      },
      {
        weight: 10,
        fn: async (ctx) => {
          await preflight(ctx, "https://app.example.com", [204]);
        },
      },
    ],
  },
};

export const HTTP_SCENARIO_NAMES = Object.keys(HTTP_SCENARIOS);
