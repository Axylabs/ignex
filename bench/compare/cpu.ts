#!/usr/bin/env bun
/**
 * bench/compare/cpu.ts — **server CPU per request at a pinned request rate**.
 *
 * Why this exists: rps A/B on a shared machine varies ±8% run to run, which is
 * larger than most optimizations. Raw throughput also conflates "does less
 * work" with "is more efficient". This mode removes both problems by driving
 * every participant at the SAME fixed rate (well below saturation, so there is
 * no queueing) and dividing the server's own CPU time by the requests served.
 *
 * Each participant is spawned through `./cpu-wrap.ts`, which imports the
 * server entry and reports `process.cpuUsage()` on SIGTERM. Rounds ALTERNATE
 * between participants and the reported number is the median, so thermal and
 * machine drift hit every participant equally.
 *
 * Usage:
 *   bun bench/compare/cpu.ts                # all participants, 3 rounds
 *   bun bench/compare/cpu.ts --gate         # exit non-zero on a regression
 *   SERVER=ignus-aot bun bench/compare/cpu.ts
 *
 * Env:
 *   CPU_RATE             target requests/sec (default 15000)
 *   CPU_SECS             measured seconds per participant per round (default 8)
 *   CPU_ROUNDS           alternating rounds (default 3)
 *   CPU_GATE_TOLERANCE   max ignus-aot / bun CPU ratio for --gate (default 1.0)
 *   SERVER               restrict to a comma-separated participant list
 *                        (e.g. `SERVER=bun,ignus-aot`)
 *
 * Writes `bench/results/compare/cpu.json` + `cpu.md`.
 */

import { PORTS, type ServerKind } from "./shared";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const WRAP = `${REPO_ROOT}bench/compare/cpu-wrap.ts`;
/** The compiled AOT artifact (built up front; see {@link buildAot}). */
const AOT_ENTRY = `${REPO_ROOT}bench/compare/servers/ignus-aot-app/dist/__server.js`;

const RATE = Number(process.env.CPU_RATE ?? 15_000);
const SECS = Number(process.env.CPU_SECS ?? 8);
const ROUNDS = Number(process.env.CPU_ROUNDS ?? 3);
const GATE = process.argv.includes("--gate") || process.env.CPU_GATE === "1";
const GATE_TOLERANCE = Number(process.env.CPU_GATE_TOLERANCE ?? 1.0);

/** Participants measured by default, cheapest-to-spawn order. */
const ALL_SERVERS: ServerKind[] = ["bun", "elysia", "ignus", "ignus-native", "ignus-aot"];
const SELECTED: ServerKind[] = process.env.SERVER
  ? (process.env.SERVER.split(",").map((s) => s.trim()) as ServerKind[])
  : ALL_SERVERS;

interface Measured {
  readonly cpuUs: number;
  readonly requests: number;
  readonly cpuPerRequest: number;
}

/** A raw test fixture used by {@link drive}. */
const rnd = (n: number): string =>
  Math.random()
    .toString(36)
    .slice(2, 2 + n);

/**
 * One request from the `03-stress` mix (see `./load.ts`):
 * 50% `GET /api/users` with a 20-char query, 30% `POST /api/users` with a JSON
 * body, 20% `GET /health`. Kept inline so this mode has no dependency on the
 * generator's internals; keep it in sync with `03-stress`.
 */
async function hit(origin: string): Promise<void> {
  const roll = Math.random();

  if (roll < 0.5) {
    const res = await fetch(`${origin}/api/users?q=${rnd(20)}&page=7`);
    await res.arrayBuffer();
    return;
  }

  if (roll < 0.8) {
    const res = await fetch(`${origin}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 4242, name: `stress_${rnd(12)}` }),
    });
    await res.arrayBuffer();
    return;
  }

  const res = await fetch(`${origin}/health`);
  await res.arrayBuffer();
}

/**
 * Drive `origin` at exactly `RATE` requests/sec for `ms`, using a token bucket
 * refilled every 10 ms. Pacing (rather than saturating) keeps the server out of
 * the queueing regime, so CPU/request measures steady-state cost rather than
 * contention.
 */
async function drive(origin: string, ms: number): Promise<number> {
  let tokens = 0;
  let served = 0;
  let stop = false;

  const refill = (async (): Promise<void> => {
    const perTick = RATE / 100;
    while (!stop) {
      tokens = Math.min(tokens + perTick, RATE / 20);
      await Bun.sleep(10);
    }
  })();

  const worker = async (): Promise<void> => {
    while (!stop) {
      if (tokens < 1) {
        await Bun.sleep(1);
        continue;
      }
      tokens -= 1;
      try {
        await hit(origin);
      } catch {
        // A failed request still costs the server scheduling work; count it so
        // the per-request figure stays honest (failures are surfaced by
        // `bench:compare:verify`, not here).
      }
      served++;
    }
  };

  const workers = Array.from({ length: 96 }, worker);
  await Bun.sleep(ms);
  stop = true;
  await Promise.all(workers);
  await refill;
  return served;
}

/** Spawn a participant through the CPU wrapper, drive it, and collect its CPU. */
async function measure(kind: ServerKind): Promise<Measured | null> {
  const entry = entryFor(kind);
  const port = PORTS[kind];
  const origin = `http://127.0.0.1:${port}`;

  const proc = Bun.spawn([process.execPath, WRAP], {
    cwd: REPO_ROOT,
    env: { ...process.env, COMPARE_SERVER_ENTRY: entry },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  // Readiness: the AOT participant compiles on first run, so allow generously.
  let ready = false;
  for (let i = 0; i < 600; i++) {
    if (proc.exitCode !== null) break;
    try {
      const res = await fetch(`${origin}/health`);
      await res.arrayBuffer();
      ready = true;
      break;
    } catch {
      await Bun.sleep(100);
    }
  }

  if (!ready) {
    const detail = await new Response(proc.stderr as ReadableStream).text();
    console.error(`[cpu] ${kind}: failed to start\n${detail.slice(0, 1200)}`);
    proc.kill("SIGKILL");
    await proc.exited;
    return null;
  }

  // Warmup (JIT + any lazy native init), then the measured window.
  await Bun.sleep(1500);
  await drive(origin, 1500);
  const requests = await drive(origin, SECS * 1000);

  proc.kill("SIGTERM");
  const out = await new Response(proc.stdout as ReadableStream).text();
  await proc.exited;

  const match = out.match(/__CPU_USAGE__ (\{[^}]*\})/);
  if (!match?.[1]) {
    console.error(`[cpu] ${kind}: no CPU report from the wrapper`);
    return null;
  }

  const { user, system } = JSON.parse(match[1]) as { user: number; system: number };
  const cpuUs = user + system;

  return { cpuUs, requests, cpuPerRequest: cpuUs / requests };
}

/** Median of an array (numeric, unsorted input). */
const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** Absolute path to a participant's server entry. */
const entryFor = (kind: ServerKind): string =>
  kind === "ignus-aot" ? AOT_ENTRY : `${REPO_ROOT}bench/compare/servers/${kind}-server.ts`;

/**
 * Build the AOT participant once, WITHOUT booting it.
 *
 * `ignus-aot-server.ts` compiles on import, so spawning it directly keeps the
 * whole compiler + bundler resident in the server's heap — measured at
 * ~35.4us/req vs ~29.9us/req for the same compiled entry spawned alone, an
 * ~18% GC penalty unrelated to the framework's runtime. Building first and
 * then measuring `dist/__server.js` in a clean process measures the artifact
 * the AOT path actually ships.
 */
async function buildAot(): Promise<void> {
  const proc = Bun.spawn(
    [process.execPath, `${REPO_ROOT}bench/compare/servers/ignus-aot-server.ts`],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, BENCH_BUILD_ONLY: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const code = await proc.exited;

  if (code !== 0 || !(await Bun.file(AOT_ENTRY).exists())) {
    const detail = await new Response(proc.stderr as ReadableStream).text();
    throw new Error(`[cpu] ignus-aot build failed (exit ${code})\n${detail.slice(0, 1500)}`);
  }
}

// ── run ───────────────────────────────────────────────────────────────
console.log(
  `[cpu] ${SELECTED.join(", ")} — pinned at ${RATE} rps, ${SECS}s × ${ROUNDS} alternating rounds\n`,
);

if (SELECTED.includes("ignus-aot")) await buildAot();

const samples: Record<string, number[]> = {};
for (const kind of SELECTED) samples[kind] = [];

for (let round = 0; round < ROUNDS; round++) {
  for (const kind of SELECTED) {
    const m = await measure(kind);
    if (m === null) continue;
    samples[kind]?.push(m.cpuPerRequest);
    console.log(
      `  round ${round + 1}  ${kind.padEnd(13)} ${m.cpuPerRequest.toFixed(2)}us/req ` +
        `(${m.requests} reqs, ${(m.cpuUs / 1_000_000).toFixed(2)}s cpu)`,
    );
    await Bun.sleep(400);
  }
}

const medians: Record<string, number> = {};
for (const [kind, xs] of Object.entries(samples)) {
  if (xs.length === 0) continue;
  medians[kind] = median(xs);
}

const baseline = medians.bun;

console.log("\n── median CPU per request ──────────────────────────────────────");
for (const kind of SELECTED) {
  const value = medians[kind];
  if (value === undefined) continue;
  const ratio = baseline === undefined ? "" : `   ${(value / baseline).toFixed(3)}x vs bun`;
  console.log(`  ${kind.padEnd(13)} ${value.toFixed(2).padStart(7)}us/req${ratio}`);
}

// ── results ───────────────────────────────────────────────────────────
const stamp = new Date().toISOString();
const report = {
  generatedAt: stamp,
  rate: RATE,
  secondsPerRound: SECS,
  rounds: ROUNDS,
  /** Median CPU microseconds per request, per participant. */
  cpuPerRequest: medians,
  /** Every individual round sample, for auditing variance. */
  samples,
};

await Bun.write(
  `${REPO_ROOT}bench/results/compare/cpu.json`,
  `${JSON.stringify(report, null, 2)}\n`,
);

const rows = SELECTED.filter((k) => medians[k] !== undefined).map(
  (k) =>
    `| \`${k}\` | ${(medians[k] ?? 0).toFixed(2)}µs | ` +
    `${baseline === undefined ? "—" : `${((medians[k] ?? 0) / baseline).toFixed(3)}x`} |`,
);

await Bun.write(
  `${REPO_ROOT}bench/results/compare/cpu.md`,
  [
    "# CPU per request (pinned pace)",
    "",
    `Generated ${stamp} — ${ROUNDS} alternating rounds of ${SECS}s at ${RATE} rps, medians.`,
    "Lower is better; the mix mirrors `03-stress` (50% GET /api/users, 30% POST /api/users, 20% GET /health).",
    "",
    "| participant | CPU/req | vs bun |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n"),
);

// ── gate ──────────────────────────────────────────────────────────────
if (GATE) {
  const aot = medians["ignus-aot"];
  if (baseline === undefined || aot === undefined) {
    console.error("\n[cpu] gate: need both `bun` and `ignus-aot` measurements");
    process.exit(1);
  }

  const ratio = aot / baseline;
  const verdict = ratio <= GATE_TOLERANCE ? "ok" : "SLOWER";
  console.log(
    `\n[cpu] ignus-aot vs bun: ${ratio.toFixed(3)}x (tolerance ${GATE_TOLERANCE}x) — ${verdict}`,
  );

  if (verdict !== "ok") process.exit(1);
}

process.exit(0);
