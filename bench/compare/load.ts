/**
 * bench/compare/load.ts — weighted-flow HTTP load generator.
 *
 * Ported from the `bun-rust-runtime-bench` project's `bench/load.ts` so the
 * comparison bench uses the exact same methodology:
 *
 *  - scenario definitions with rate-paced phases (rps; `0` = idle, omitted =
 *    fire as fast as possible) and weighted flows,
 *  - an O(1) concurrency gate (`maxConcurrent` requests in flight),
 *  - per-phase throughput + latency stats (the phase table is what tells you
 *    the real sustained capacity; the run-wide average hides it),
 *  - HDR-style log-bucket latency histograms (1.1% relative error) so workers
 *    can be merged exactly without shipping raw samples,
 *  - outcome classification (success / expected_error / unexpected_status /
 *    timeout / network_error / shape_failure),
 *  - response-shape validation of every 2xx (`ok === true` + `requestId`
 *    string) — the wire-format contract,
 *  - per-server reports: `<scenario>.bench.json|md|html` + failures ndjson.
 *
 * Scaling: a single Bun process tops out around 40-50k rps on loopback, so the
 * generator runs `workers` OS processes and merges their histograms. The client
 * must never be the bottleneck or the numbers measure the generator instead of
 * the server.
 *
 * Env:
 *   HTTP_NO_SHAPE=1     skip response-shape validation (pure throughput soak)
 *   DURATION_SCALE=n    multiply every phase duration (default 1) for quick runs
 *   HTTP_WARMUP_SEC=n   unpaced warm-up before phase 1, excluded from stats
 *   HTTP_MAX_CONCURRENT=n  override every scenario's in-flight ceiling
 *   HTTP_WORKERS=n      load-generator processes (default: auto)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NO_SHAPE = (process.env.HTTP_NO_SHAPE ?? "").trim().toLowerCase() === "1";
const DURATION_SCALE = Math.max(0.01, Number(process.env.DURATION_SCALE ?? 1));
/** Unpaced warm-up (JIT + connection pool) before the timed phases. */
const WARMUP_SEC = Math.max(0, Number(process.env.HTTP_WARMUP_SEC ?? 2));
/** Optional global override for every scenario's `maxConcurrent`. */
const MAX_CONCURRENT_OVERRIDE = Number(process.env.HTTP_MAX_CONCURRENT ?? 0);

/**
 * How many generator processes a scenario deserves.
 *
 * Low-rate, pacing-dominated scenarios (smoke, edge cases, the error-path
 * suites) gain nothing from sharding — the load generator is idle most of the
 * time and extra processes only add startup noise. Only scenarios that push
 * hard (an unpaced phase, or a several-hundred-rps paced target) get sharded.
 */
function workersFor(def: LoadScenarioDef): number {
  const configured = resolveWorkerCount();
  if (configured <= 1) return 1;
  const unpaced = def.phases.some((p) => p.rate === undefined);
  const peakRate = Math.max(0, ...def.phases.map((p) => p.rate ?? 0));
  if (!unpaced && peakRate <= 600) return 1;
  return configured;
}

/**
 * Load-generator process count. One Bun process saturates its own event loop
 * long before a server does, so the client is sharded across processes and the
 * per-process results are merged. Auto = half the logical CPUs, capped at 4
 * (the servers are single-process, so stealing every core would suppress the
 * thing we are trying to measure).
 */
export function resolveWorkerCount(): number {
  const explicit = Number(process.env.HTTP_WORKERS ?? process.env.LOAD_WORKERS ?? 0);
  if (Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit);
  const cpus = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(4, Math.floor(cpus / 3)));
}

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
  /** Index into `Recorder.phases` — what all stats are keyed by. */
  phaseIndex: number;
  vu: number;
  iter: number;
  recorder: Recorder;
  /**
   * Caps in-flight HTTP requests. This is what `maxConcurrent` means: think
   * time inside a flow (`sleep` between calls) must not consume a slot, or a
   * paced think-time scenario throttles itself into a false "client-limited".
   */
  gate: Gate;
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
  phaseIndex: number;
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
  hist: Histogram;
  statuses: Record<string, number>;
}

/** Per-phase throughput + latency. The headline capacity number lives here. */
interface PhaseStat {
  index: number;
  name: string;
  /** Configured rps, or null for an unpaced ("as fast as possible") phase. */
  targetRps: number | null;
  /** rate × duration — how many requests the schedule asked for. */
  targetRequests: number;
  count: number;
  errors: number;
  hist: Histogram;
  /** Wall-clock window the phase was *scheduled* for (ms since recorder start). */
  startedMonoMs: number;
  endedMonoMs: number;
  /** Launch wall-clock window in ms — the rps denominator. */
  launchDurationMs: number;
  /**
   * True when a paced phase fell short of its target because the generator
   * could not keep up — the number below is a client ceiling, not a server one.
   */
  clamped: boolean;
}

/** Histogram wire form. */
type SerializedHistogram = Array<[number, number]>;

interface SerializedPhase {
  index: number;
  name: string;
  targetRps: number | null;
  targetRequests: number;
  count: number;
  errors: number;
  hist: SerializedHistogram;
  startedMonoMs: number;
  endedMonoMs: number;
  launchDurationMs: number;
  clamped: boolean;
}

interface SerializedRoute {
  name: string;
  count: number;
  errors: number;
  statuses: Record<string, number>;
  hist: SerializedHistogram;
}

/** What a `--worker` process reports back to the orchestrator on stdout. */
interface WorkerSnapshot {
  total: number;
  success: number;
  expectedErrors: number;
  failed: number;
  timeouts: number;
  networkErrors: number;
  unexpectedStatuses: number;
  shapeFailures: number;
  /** Wall clock the shard actually spent running its phases (ms). */
  runDurationMs: number;
  histAll: SerializedHistogram;
  phases: SerializedPhase[];
  routes: SerializedRoute[];
  errorGroups: ErrorGroup[];
  failureSamples: RequestTrace[];
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

// ── Latency histogram ─────────────────────────────────────────────
// Log-bucket histogram keyed on microseconds: bucket index is
// `floor(log2(µs) * SUB) + OFFSET`, so every bucket spans a fixed 2^(1/SUB)
// ratio and the relative error is bounded by 2^(1/(2·SUB)) − 1 ≈ 0.55% at
// SUB=64. Compact (≈2.5k buckets ≈ 10 KB), O(1) recording, and — crucially —
// *mergeable*, so N worker processes can be summed into exact percentiles
// without shipping a single raw sample.
const HIST_SUB = 64;
const HIST_OFFSET = 1024;
const HIST_SIZE = 4096;
const HIST_MIN_US = 1;

function bucketIndex(us: number): number {
  const v = us > HIST_MIN_US ? us : HIST_MIN_US;
  const idx = (Math.floor(Math.log2(v) * HIST_SUB) + HIST_OFFSET) | 0;
  return idx < 0 ? 0 : idx >= HIST_SIZE ? HIST_SIZE - 1 : idx;
}

function bucketValue(idx: number): number {
  return 2 ** ((idx - HIST_OFFSET + 0.5) / HIST_SUB);
}

class Histogram {
  buckets = new Uint32Array(HIST_SIZE);
  count = 0;
  totalUs = 0;
  minUs = Number.POSITIVE_INFINITY;
  maxUs = 0;

  record(us: number): void {
    const v = Number.isFinite(us) && us > 0 ? us : 0;
    this.count++;
    this.totalUs += v;
    if (v < this.minUs) this.minUs = v;
    if (v > this.maxUs) this.maxUs = v;
    this.buckets[bucketIndex(v)]++;
  }

  merge(other: Histogram): void {
    this.count += other.count;
    this.totalUs += other.totalUs;
    if (other.minUs < this.minUs) this.minUs = other.minUs;
    if (other.maxUs > this.maxUs) this.maxUs = other.maxUs;
    for (let i = 0; i < HIST_SIZE; i++) {
      const v = other.buckets[i];
      if (v !== 0) this.buckets[i] += v;
    }
  }

  /** Upper bound of the bucket holding the requested percentile (µs). */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    const rank = Math.ceil((p / 100) * this.count);
    let cum = 0;
    for (let i = 0; i < HIST_SIZE; i++) {
      cum += this.buckets[i];
      if (cum >= rank) return bucketValue(i);
    }
    return this.maxUs;
  }

  get min(): number {
    return this.count === 0 || !Number.isFinite(this.minUs) ? 0 : this.minUs;
  }

  get max(): number {
    return this.maxUs;
  }

  get avg(): number {
    return this.count === 0 ? 0 : this.totalUs / this.count;
  }

  /** Sparse wire form: `[[bucketIndex, count], …]`. */
  serialize(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < HIST_SIZE; i++) {
      const v = this.buckets[i];
      if (v !== 0) out.push([i, v]);
    }
    return out;
  }

  static deserialize(entries: Array<[number, number]>): Histogram {
    const h = new Histogram();
    const buckets = new Uint32Array(HIST_SIZE);
    for (const entry of entries ?? []) {
      const idx = entry[0];
      const count = entry[1];
      if (!Number.isInteger(idx) || idx < 0 || idx >= HIST_SIZE || !Number.isFinite(count)) {
        continue;
      }
      buckets[idx] = count;
      h.count += count;
      const value = bucketValue(idx);
      h.totalUs += value * count;
      if (value < h.minUs) h.minUs = value;
      if (value > h.maxUs) h.maxUs = value;
    }
    h.buckets = buckets;
    return h;
  }
}

/**
 * O(1) counting gate. The previous implementation awaited
 * `Promise.race(activeSet)` while at capacity, which is O(in-flight) *per
 * completed request*: at `maxConcurrent = 10_000` that is 10k reaction
 * registrations for every response, and it collapsed the whole run to ~1.8k rps
 * (vs ~24k rps with this gate). Slots hand off directly to the next waiter.
 */
interface Gate {
  acquire(): Promise<void> | undefined;
  release(): void;
  readonly size: number;
}

function createGate(max: number): Gate {
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  return {
    acquire(): Promise<void> | undefined {
      if (inFlight < max) {
        inFlight++;
        return undefined;
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    release(): void {
      const next = waiters.shift();
      if (next) next();
      else inFlight--;
    },
    get size(): number {
      return inFlight;
    },
  };
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

  /** Run-wide latency (all phases, all routes). */
  histAll = new Histogram();
  routeStats = new Map<string, RouteStat>();
  phases: PhaseStat[] = [];
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

  /** Declare the phase timeline up front so `record()` just indexes into it. */
  declarePhases(
    defs: Array<{ name: string; targetRps: number | null; targetRequests: number }>,
  ): void {
    this.phases = defs.map((d, index) => ({
      index,
      name: d.name,
      targetRps: d.targetRps,
      targetRequests: d.targetRequests,
      count: 0,
      errors: 0,
      hist: new Histogram(),
      startedMonoMs: 0,
      endedMonoMs: 0,
      launchDurationMs: 0,
      clamped: false,
    }));
  }

  markPhaseStart(index: number): void {
    const phase = this.phases[index];
    if (phase) phase.startedMonoMs = (Bun.nanoseconds() - this.startMono) / 1_000_000;
  }

  markPhaseEnd(index: number, launchDurationMs: number): void {
    const phase = this.phases[index];
    if (!phase) return;
    phase.endedMonoMs = (Bun.nanoseconds() - this.startMono) / 1_000_000;
    phase.launchDurationMs = launchDurationMs;
    if (phase.targetRequests > 0) {
      // A paced phase that served <98% of its schedule was limited by the
      // generator, not the server — flag it so the report cannot be misread.
      phase.clamped = phase.count < phase.targetRequests * 0.98;
    }
  }

  record(input: RecordInput): void {
    const monoMs = (Bun.nanoseconds() - this.startMono) / 1_000_000;
    const latencyUs = input.latencyMs * 1000;

    this.total++;
    this.histAll.record(latencyUs);

    const phase = this.phases[input.phaseIndex];
    if (phase) {
      phase.count++;
      phase.hist.record(latencyUs);
    }

    const routeKey = `${input.method} ${input.route}`;
    let route = this.routeStats.get(routeKey);
    if (!route) {
      route = { count: 0, errors: 0, hist: new Histogram(), statuses: {} };
      this.routeStats.set(routeKey, route);
    }
    route.count++;
    route.hist.record(latencyUs);
    const statusKey = String(input.status || 0);
    route.statuses[statusKey] = (route.statuses[statusKey] ?? 0) + 1;
    if (input.status === 0 || input.status >= 400) {
      route.errors++;
      if (phase) phase.errors++;
    }

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
      phaseIndex: input.phaseIndex,
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
      phaseIndex: ctx.phaseIndex,
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

  /** Wire form for cross-process merge (`--worker` mode prints this as JSON). */
  serialize(): WorkerSnapshot {
    return {
      total: this.total,
      success: this.success,
      expectedErrors: this.expectedErrors,
      failed: this.failed,
      timeouts: this.timeouts,
      networkErrors: this.networkErrors,
      unexpectedStatuses: this.unexpectedStatuses,
      shapeFailures: this.shapeFailures,
      runDurationMs: (Bun.nanoseconds() - this.startMono) / 1_000_000,
      histAll: this.histAll.serialize(),
      phases: this.phases.map((p) => ({
        index: p.index,
        name: p.name,
        targetRps: p.targetRps,
        targetRequests: p.targetRequests,
        count: p.count,
        errors: p.errors,
        hist: p.hist.serialize(),
        startedMonoMs: p.startedMonoMs,
        endedMonoMs: p.endedMonoMs,
        launchDurationMs: p.launchDurationMs,
        clamped: p.clamped,
      })),
      routes: [...this.routeStats.entries()].map(([name, s]) => ({
        name,
        count: s.count,
        errors: s.errors,
        statuses: s.statuses,
        hist: s.hist.serialize(),
      })),
      errorGroups: [...this.errorGroups.values()],
      failureSamples: this.failureSamples,
    };
  }

  /** Fold a worker's snapshot into this recorder (counts, histograms, groups). */
  mergeSnapshot(snap: WorkerSnapshot): void {
    this.total += snap.total;
    this.success += snap.success;
    this.expectedErrors += snap.expectedErrors;
    this.failed += snap.failed;
    this.timeouts += snap.timeouts;
    this.networkErrors += snap.networkErrors;
    this.unexpectedStatuses += snap.unexpectedStatuses;
    this.shapeFailures += snap.shapeFailures;
    this.histAll.merge(Histogram.deserialize(snap.histAll));
    this.mergePhases(snap.phases);
    this.mergeRoutes(snap.routes);
    this.mergeErrorGroups(snap.errorGroups);
    for (const sample of snap.failureSamples) {
      if (this.failureSamples.length < this.maxFailureSamples) this.failureSamples.push(sample);
    }
  }

  private mergePhases(snapPhases: SerializedPhase[]): void {
    for (const wp of snapPhases) {
      const phase = this.phases[wp.index];
      if (!phase) continue;
      phase.count += wp.count;
      phase.errors += wp.errors;
      phase.hist.merge(Histogram.deserialize(wp.hist));
      // Workers run the same wall-clock schedule; keep the widest window so
      // the aggregate rps denominator covers every shard.
      phase.startedMonoMs = Math.min(phase.startedMonoMs || wp.startedMonoMs, wp.startedMonoMs);
      phase.endedMonoMs = Math.max(phase.endedMonoMs, wp.endedMonoMs);
      phase.launchDurationMs = Math.max(phase.launchDurationMs, wp.launchDurationMs);
      if (phase.targetRequests > 0) {
        phase.clamped = phase.count < phase.targetRequests * 0.98;
      }
    }
  }

  private mergeRoutes(snapRoutes: SerializedRoute[]): void {
    for (const wr of snapRoutes) {
      let route = this.routeStats.get(wr.name);
      if (!route) {
        route = { count: 0, errors: 0, hist: new Histogram(), statuses: {} };
        this.routeStats.set(wr.name, route);
      }
      route.count += wr.count;
      route.errors += wr.errors;
      route.hist.merge(Histogram.deserialize(wr.hist));
      for (const [status, n] of Object.entries(wr.statuses)) {
        route.statuses[status] = (route.statuses[status] ?? 0) + n;
      }
    }
  }

  private mergeErrorGroups(snapGroups: ErrorGroup[]): void {
    for (const group of snapGroups) {
      const existing = this.errorGroups.get(group.key);
      if (!existing) {
        this.errorGroups.set(group.key, { ...group, samples: group.samples.slice(0, 3) });
        continue;
      }
      existing.count += group.count;
      existing.firstMonoMs = Math.min(existing.firstMonoMs, group.firstMonoMs);
      existing.lastMonoMs = Math.max(existing.lastMonoMs, group.lastMonoMs);
      for (const sample of group.samples) {
        if (existing.samples.length < 3) existing.samples.push(sample);
      }
    }
  }

  async end(): Promise<void> {
    await this.failureWriter.end();
  }
}

// ── send(): one request ───────────────────────────────────────────

/** Classify a completed response into an outcome + error metadata. */
function classifyOutcome(
  status: number,
  parsed: unknown,
  expected: number[],
  requireShape: boolean,
): { outcome: Outcome; errorCode: string; errorMessage: string } {
  const err = parsed as { error?: { code?: string; message?: string } } | null;

  if (!expected.includes(status)) {
    return {
      outcome: "unexpected_status",
      errorCode: err?.error?.code ?? "unexpected_status",
      errorMessage: err?.error?.message ?? `Unexpected status ${status}`,
    };
  }
  if (status >= 400) {
    return {
      outcome: "expected_error",
      errorCode: err?.error?.code ?? "expected_error",
      errorMessage: err?.error?.message ?? "Expected error response",
    };
  }
  if (requireShape && !NO_SHAPE) {
    const shape = parsed as { ok?: unknown; requestId?: unknown } | null;
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

  // In-flight request slot. Acquired here (not around the whole flow) so
  // concurrency means concurrent *requests*, independent of flow think time.
  const slot = ctx.gate.acquire();
  if (slot) await slot;

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

    // Parse exactly once: classification + shape check + failure snippet all
    // read the same object (the old code ran JSON.parse twice per 2xx).
    const parsed = safeJson(text);
    const classification = classifyOutcome(status, parsed, expected, opts.requireShape !== false);
    outcome = classification.outcome;
    errorCode = classification.errorCode;
    errorMessage = classification.errorMessage;

    ctx.recorder.record({
      phase: ctx.phase,
      phaseIndex: ctx.phaseIndex,
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
      phaseIndex: ctx.phaseIndex,
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
    ctx.gate.release();
  }
}

// ── stats / reports ───────────────────────────────────────────────
/** Percentile view of a histogram, in ms (the report's unit). */
function stats(hist: Histogram) {
  if (hist.count === 0) {
    return { count: 0, avg: 0, min: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, p999: 0, max: 0 };
  }
  return {
    count: hist.count,
    avg: hist.avg / 1000,
    min: hist.min / 1000,
    p50: hist.percentile(50) / 1000,
    p75: hist.percentile(75) / 1000,
    p90: hist.percentile(90) / 1000,
    p95: hist.percentile(95) / 1000,
    p99: hist.percentile(99) / 1000,
    p999: hist.percentile(99.9) / 1000,
    max: hist.max / 1000,
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
  /** Load-generator processes that produced this report. */
  workers: number;
  totalDurationMs: number;
  /** Total requests ÷ full wall clock (includes ramps + drain). */
  achievedRps: number;
  /**
   * Highest sustained rps across the phases — the real throughput headline.
   * Averages over the whole run hide it behind ramp/idle phases.
   */
  peakRps: number;
  /** Phase the peak came from. */
  peakPhase: string;
  /**
   * False when no phase was unpaced, i.e. the "peak" is just the highest
   * pacing target the generator managed to hold — not a capacity figure.
   */
  peakUnpaced: boolean;
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
  phases: Array<Record<string, number | string | boolean | null>>;
  routes: Array<Record<string, number | string | Record<string, number>>>;
  errorGroups: ErrorGroup[];
  failureSamples: RequestTrace[];
}

/** Per-phase rows: the honest picture of how throughput evolved. */
function phaseRows(report: BenchReport): unknown[][] {
  return report.phases.map((p) => [
    p.name,
    p.targetRps === null ? "max" : String(p.targetRps),
    p.requests,
    fmtMs(p.durationMs as number),
    (p.achievedRps as number).toFixed(2),
    p.errors,
    p.clamped ? "yes (client-limited)" : "no",
    fmtMs(p.p50 as number),
    fmtMs(p.p95 as number),
    fmtMs(p.p99 as number),
    fmtMs(p.max as number),
  ]);
}

function overviewRows(report: BenchReport): unknown[][] {
  return [
    ["Server", report.server],
    ["Scenario", report.scenario],
    ["Generated", report.generatedAt],
    ["Load generators", report.workers],
    ["Total duration ms", fmtMs(report.totalDurationMs)],
    ["Peak sustained RPS", report.peakRps.toFixed(2)],
    [
      "Peak phase",
      `${report.peakPhase}${report.peakUnpaced ? "" : " (pacing target — no unpaced phase)"}`,
    ],
    ["Achieved RPS (run average)", report.achievedRps.toFixed(2)],
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

## Phase throughput

Each phase is measured separately: **Target rps** is the configured rate (max = fire as fast as
possible), **Achieved rps** is what actually landed, and **Client-limited** flags a paced phase the
generator could not keep up with — treat those as a load-generator ceiling, not a server one.

${mdTable(
  [
    "Phase",
    "Target rps",
    "Requests",
    "Duration ms",
    "Achieved rps",
    "Errors",
    "Client-limited",
    "p50 ms",
    "p95 ms",
    "p99 ms",
    "Max ms",
  ],
  phaseRows(report),
)}

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

<h2>Phase throughput</h2>
<p>Each phase is measured separately: <code>target</code> is the configured rps (<code>max</code> = fire as fast as possible), <code>achieved</code> is what actually landed, and <code>client-limited</code> flags a paced phase the generator could not keep up with — treat those as a load-generator ceiling, not a server one.</p>
${htmlTable(
  [
    "Phase",
    "Target rps",
    "Requests",
    "Duration ms",
    "Achieved rps",
    "Errors",
    "Client-limited",
    "p50 ms",
    "p95 ms",
    "p99 ms",
    "Max ms",
  ],
  phaseRows(report),
)}

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

function buildReport(
  recorder: Recorder,
  workers: number,
  durationOverrideMs?: number,
): BenchReport {
  const totalDurationMs =
    durationOverrideMs ?? (Bun.nanoseconds() - recorder.startMono) / 1_000_000;
  const global = stats(recorder.histAll);

  const routes = [...recorder.routeStats.entries()]
    .map(([name, s]) => {
      const st = stats(s.hist);
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

  const phases = recorder.phases.map((p) => {
    const st = stats(p.hist);
    const durationMs = p.launchDurationMs || Math.max(p.endedMonoMs - p.startedMonoMs, 0);
    return {
      index: p.index,
      name: p.name,
      targetRps: p.targetRps,
      requests: p.count,
      durationMs,
      achievedRps: durationMs > 0 ? p.count / (durationMs / 1000) : 0,
      errors: p.errors,
      clamped: p.clamped,
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
  });

  // Peak = the best sustained phase, preferring an unpaced phase because only
  // that measures capacity; a paced phase can never exceed its target. When the
  // scenario has no unpaced phase we fall back to the best paced phase and flag
  // it via `peakUnpaced` so the number is not mistaken for a ceiling.
  const unpaced = phases.filter((p) => p.targetRps === null && p.requests > 0);
  const candidates = unpaced.length > 0 ? unpaced : phases.filter((p) => p.requests > 0);
  let peakRps = 0;
  let peakPhase = "";
  for (const p of candidates) {
    if (p.achievedRps > peakRps) {
      peakRps = p.achievedRps;
      peakPhase = p.name;
    }
  }
  const peakUnpaced = unpaced.length > 0;

  const errorGroups = [...recorder.errorGroups.values()].sort((a, b) => b.count - a.count);

  // Total wall clock covers every phase plus the drain between them.
  const fullDurationMs = totalDurationMs;

  return {
    server: recorder.server,
    scenario: recorder.scenario,
    generatedAt: new Date().toISOString(),
    workers,
    totalDurationMs: fullDurationMs,
    achievedRps: recorder.total / Math.max(fullDurationMs / 1000, 1e-9),
    peakRps,
    peakPhase,
    peakUnpaced,
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
    phases,
    routes,
    errorGroups,
    failureSamples: recorder.failureSamples,
  };
}

/** One-line-per-phase progress trace (also used by the sharded path). */
function logPhases(report: BenchReport): void {
  for (const p of report.phases) {
    const target = p.targetRps === null ? "max" : String(p.targetRps);
    console.log(
      `    · ${String(p.name).padEnd(22)} ${String(p.requests).padStart(8)} req  ` +
        `${(p.achievedRps as number).toFixed(0).padStart(7)} rps  ` +
        `(target ${target})  p50 ${fmtMs(p.p50 as number)}ms` +
        (p.clamped ? "  ⚠ client-limited" : ""),
    );
  }
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

/** Sleep until the `scheduled`-th paced slot is due; return at once if late. */
async function paceWait(phaseStart: number, intervalNs: number, scheduled: number): Promise<void> {
  const due = phaseStart + intervalNs * scheduled;
  const now = Bun.nanoseconds();
  if (due <= now) return;
  const waitMs = (due - now) / 1_000_000;
  // Long waits sleep most of the gap; short ones yield so the event loop can
  // service the in-flight responses we are pacing against.
  if (waitMs > 2) await Bun.sleep(waitMs - 1);
  else await Bun.sleep(0);
}

// ── executeScenario: paced scheduling + concurrency gate ──────────
/**
 * Run one shard of a scenario. When `shard` is set, this process drives
 * `1/workerCount` of the paced rate and keeps its own `maxConcurrent` slice;
 * unpaced phases run flat out. Results land in `recorder`.
 */
async function executeScenario(
  def: LoadScenarioDef,
  env: {
    server: string;
    port: number;
    recorder: Recorder;
    shard?: { index: number; count: number };
  },
): Promise<{ drainMs: number }> {
  const base = `http://localhost:${env.port}`;
  const shardCount = Math.max(1, env.shard?.count ?? 1);
  const quiet = env.shard !== undefined;

  // `maxConcurrent` is the in-flight HTTP request ceiling for the scenario.
  // Divided across workers so aggregate concurrency is stable regardless of how
  // many generator processes run.
  const ceiling =
    MAX_CONCURRENT_OVERRIDE > 0 ? MAX_CONCURRENT_OVERRIDE : (def.maxConcurrent ?? 256);
  const maxConcurrent = Math.max(1, Math.ceil(ceiling / shardCount));

  // Two O(1) gates: one caps live HTTP requests, the other caps live flow
  // iterations (memory safety for unpaced phases with slow/think-time flows).
  const requestGate = createGate(maxConcurrent);
  const iterationGate = createGate(Math.max(512, maxConcurrent * 4));
  const active = new Set<Promise<void>>();
  let vuSeq = 0;
  let iterSeq = 0;

  function launch(phaseName: string, phaseIndex: number): void {
    const vu = ++vuSeq;
    const iter = ++iterSeq;
    const ctx: FlowCtx = {
      base,
      server: env.server,
      scenario: def.name,
      phase: phaseName,
      phaseIndex,
      vu,
      iter,
      recorder: env.recorder,
      gate: requestGate,
    };
    const flow = pickWeighted(def.flows).fn;
    let p: Promise<void> | undefined;
    const tracked = (async () => {
      try {
        await flow(ctx);
      } catch (err) {
        env.recorder.recordUnhandled(ctx, err);
      } finally {
        active.delete(p as Promise<void>);
        iterationGate.release();
      }
    })();
    p = tracked;
    active.add(p);
  }

  /** Fire for `durationNs` with O(1) gates; returns the launch window in ms. */
  async function burn(
    phaseIndex: number,
    phaseName: string,
    durationNs: number,
    rate?: number,
  ): Promise<number> {
    const shardRate = rate === undefined ? undefined : rate / shardCount;
    const intervalNs = shardRate === undefined || shardRate <= 0 ? 0 : 1_000_000_000 / shardRate;
    const phaseStart = Bun.nanoseconds();
    const phaseEnd = phaseStart + durationNs;
    let scheduled = 0;

    for (;;) {
      if (Bun.nanoseconds() >= phaseEnd) break;
      if (intervalNs > 0) await paceWait(phaseStart, intervalNs, scheduled);

      // Backpressure on live iterations, then fire (the request slot is taken
      // inside `send()` so flow think time never holds one).
      const slot = iterationGate.acquire();
      if (slot) await slot;
      if (Bun.nanoseconds() >= phaseEnd) {
        iterationGate.release();
        break;
      }
      launch(phaseName, phaseIndex);
      scheduled++;
    }

    // The launch window closes as soon as we stop firing; the drain below is
    // bookkeeping, not throughput, so keep it out of the rps denominator.
    const windowMs = (Bun.nanoseconds() - phaseStart) / 1_000_000;
    // Let in-flight requests for this phase land before its stats are read,
    // so a slow phase cannot bleed into the next one's latency.
    await Promise.allSettled(active);
    return windowMs;
  }

  for (let index = 0; index < def.phases.length; index++) {
    const phase = def.phases[index] as LoadPhase;
    const name = phase.name ?? `phase ${index + 1}`;
    const durationNs = phase.durationSec * DURATION_SCALE * 1_000_000_000;
    const rate = phase.rate;

    if (rate !== undefined && rate <= 0) {
      env.recorder.markPhaseStart(index);
      await Bun.sleep(phase.durationSec * DURATION_SCALE * 1000);
      env.recorder.markPhaseEnd(index, 0);
      continue;
    }

    env.recorder.markPhaseStart(index);
    const windowMs = await burn(index, name, durationNs, rate);
    env.recorder.markPhaseEnd(index, windowMs);

    const expected = rate === undefined ? null : Math.floor((rate * durationNs) / 1e9);
    if (!quiet) {
      console.log(
        `    · ${name.padEnd(22)} ${windowMs.toFixed(0).padStart(5)}ms  ` +
          `${(env.recorder.phases[index]?.count ?? 0).toString().padStart(7)} req  ` +
          (expected === null
            ? `${((env.recorder.phases[index]?.count ?? 0) / (windowMs / 1000)).toFixed(0)} rps`
            : `target ${expected} req`),
      );
    }
  }

  await Promise.allSettled(active);
}

/** Shared by the in-process run and the `--worker` shard entry point. */
export interface ScenarioRunOptions {
  scenario: string;
  server: string;
  port: number;
  outDir?: string;
  shard?: { index: number; count: number };
}

/** Prepare a recorder with the scenario's phase timeline declared. */
export function prepareRecorder(def: LoadScenarioDef, opts: ScenarioRunOptions): Recorder {
  const outDir = opts.outDir ?? `./bench/results/compare/${opts.server}`;
  const recorder = new Recorder(opts.server, opts.scenario, outDir);
  recorder.declarePhases(
    def.phases.map((p, i) => {
      const durationSec = p.durationSec * DURATION_SCALE;
      return {
        name: p.name ?? `phase ${i + 1}`,
        targetRps: p.rate === undefined ? null : p.rate,
        // Aggregate across shards: each shard drives rate/shardCount, so the
        // whole run's schedule asks for rate × duration.
        targetRequests: p.rate === undefined || p.rate <= 0 ? 0 : Math.floor(p.rate * durationSec),
      };
    }),
  );
  return recorder;
}

/** Unpaced warm-up so JIT + connection pools are hot before phase 1. */
export async function warmup(port: number, scenario: string): Promise<void> {
  if (WARMUP_SEC <= 0) return;
  const def = HTTP_SCENARIOS[scenario];
  if (!def) return;
  const base = `http://localhost:${port}`;
  const deadline = Bun.nanoseconds() + WARMUP_SEC * 1e9;
  const concurrency = Math.min(64, def.maxConcurrent ?? 64);
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (Bun.nanoseconds() < deadline) {
        try {
          const res = await fetch(`${base}/health`);
          await res.text();
        } catch {
          return;
        }
      }
    }),
  );
}

/** Spin until `startAt` (epoch ms) so every shard begins phase 1 together. */
async function alignStart(startAt?: number): Promise<void> {
  if (!startAt || !Number.isFinite(startAt)) return;
  for (;;) {
    const remaining = startAt - Date.now();
    if (remaining <= 0) return;
    await Bun.sleep(Math.min(remaining, 25));
  }
}

/** Marker the orchestrator scans for in a worker's stdout. */
export const WORKER_RESULT_PREFIX = "@@IGNEX_BENCH_WORKER@@";

/** Worker entry point: run one shard and hand back a serializable snapshot. */
export async function runScenarioWorker(opts: ScenarioRunOptions & { startAt?: number }) {
  const def = HTTP_SCENARIOS[opts.scenario];
  if (!def) throw new Error(`Unknown scenario: ${opts.scenario}`);
  const recorder = prepareRecorder(def, opts);
  await warmup(opts.port, opts.scenario);
  await alignStart(opts.startAt);
  await executeScenario(def, {
    server: opts.server,
    port: opts.port,
    recorder,
    shard: opts.shard,
  });
  await recorder.end();
  return recorder.serialize();
}

/**
 * Run a scenario, sharding the load generator across processes when asked.
 *
 * The generator is deliberately multi-process: one Bun process cannot drive a
 * modern server on loopback, so a single-process run silently reports the
 * client's ceiling as the server's throughput. Workers each cover 1/N of the
 * paced rate, write their own failure trace, and the orchestrator merges the
 * histograms into exact percentiles.
 */
export async function runHttpScenario(opts: ScenarioRunOptions): Promise<void> {
  const def = HTTP_SCENARIOS[opts.scenario];
  if (!def) {
    throw new Error(
      `Unknown scenario: ${opts.scenario}. Valid scenarios: ${HTTP_SCENARIO_NAMES.join(", ")}`,
    );
  }
  const outDir = opts.outDir ?? `./bench/results/compare/${opts.server}`;
  const workers = opts.shard ? 1 : workersFor(def);

  console.log(`\n${"═".repeat(60)}`);
  console.log(
    `  ${opts.server.toUpperCase()}  ×  ${opts.scenario}  (${workers} generator${workers > 1 ? "s" : ""})`,
  );
  console.log(`${"═".repeat(60)}`);

  const recorder = prepareRecorder(def, opts);

  if (workers <= 1) {
    await warmup(opts.port, opts.scenario);
    await executeScenario(def, { server: opts.server, port: opts.port, recorder });
    await recorder.end();
    await writeReports(buildReport(recorder, 1), outDir, opts.scenario);
    return;
  }

  const { snapshots, runDurationMs, failures } = await runSharded(opts, workers, recorder);
  await recorder.end(); // closes (and truncates) the final trace file
  writeFileSync(join(outDir, `${opts.scenario}.failures.ndjson`), failures.join(""));

  const report = buildReport(recorder, snapshots, runDurationMs);
  logPhases(report);
  await writeReports(report, outDir, opts.scenario);
}

/** Spawn `workers` shard processes, collect and merge their snapshots. */
async function runSharded(
  opts: ScenarioRunOptions,
  workers: number,
  recorder: Recorder,
): Promise<{ snapshots: number; runDurationMs: number; failures: string[] }> {
  const tempDir = mkdtempSync(join(tmpdir(), "ignex-bench-"));
  // Every shard waits for the same wall-clock instant so the phases line up.
  const startAt = Date.now() + 2_500;
  const traceFiles: string[] = [];
  const procs: Array<{ proc: ReturnType<typeof Bun.spawn>; outDir: string }> = [];

  try {
    for (let index = 0; index < workers; index++) {
      const workerOutDir = join(tempDir, `w${index}`);
      mkdirSync(workerOutDir, { recursive: true });
      traceFiles.push(join(workerOutDir, `${opts.scenario}.failures.ndjson`));
      procs.push({
        outDir: workerOutDir,
        proc: Bun.spawn(["bun", "run", "bench/compare/worker.ts"], {
          stdout: "pipe",
          stderr: "inherit",
          env: {
            ...process.env,
            BENCH_SCENARIO: opts.scenario,
            BENCH_SERVER: opts.server,
            BENCH_PORT: String(opts.port),
            BENCH_OUT_DIR: workerOutDir,
            BENCH_WORKER_INDEX: String(index),
            BENCH_WORKER_COUNT: String(workers),
            BENCH_START_AT: String(startAt),
          },
        }),
      });
    }

    let runDurationMs = 0;
    for (const { proc } of procs) {
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new Error(
          `load-generator worker exited with code ${exitCode} ` +
            `(stdout tail: ${stdout.slice(-300) || "<empty>"})`,
        );
      }
      const line = stdout.split("\n").find((l) => l.startsWith(WORKER_RESULT_PREFIX));
      if (!line) {
        throw new Error(
          `load-generator worker produced no result line (stdout tail: ` +
            `${stdout.slice(-300) || "<empty>"})`,
        );
      }
      const snapshot = JSON.parse(line.slice(WORKER_RESULT_PREFIX.length)) as WorkerSnapshot;
      recorder.mergeSnapshot(snapshot);
      runDurationMs = Math.max(runDurationMs, snapshot.runDurationMs);
    }

    const failures = traceFiles
      .map((p) => (existsSync(p) ? readFileSync(p, "utf8") : ""))
      .filter(Boolean);
    return { snapshots: workers, runDurationMs, failures };
  } finally {
    for (const { proc } of procs) proc.kill();
    rmSync(tempDir, { recursive: true, force: true });
  }
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
    maxConcurrent: 128,
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
    maxConcurrent: 256,
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
    maxConcurrent: 256,
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
    maxConcurrent: 128,
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
    maxConcurrent: 128,
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
    maxConcurrent: 128,
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
    maxConcurrent: 256,
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
    maxConcurrent: 256,
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
    maxConcurrent: 256,
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
    maxConcurrent: 128,
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
    maxConcurrent: 256,
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
