#!/usr/bin/env bun
/**
 * bench/compare/worker.ts — one load-generator shard process.
 *
 * A single Bun process saturates its own event loop (~40-50k rps on loopback
 * for a trivial route, far less once the flow does real JSON work), so
 * `run-bench.ts` fans a scenario out across several of these and merges the
 * results. This process owns 1/N of the paced rate and 1/N of the in-flight
 * ceiling; it prints exactly one `WORKER_RESULT_PREFIX`-prefixed JSON line on
 * stdout and exits.
 *
 * Env (set by the orchestrator):
 *   BENCH_SCENARIO, BENCH_SERVER, BENCH_PORT, BENCH_OUT_DIR
 *   BENCH_WORKER_INDEX, BENCH_WORKER_COUNT
 *   BENCH_START_AT   epoch ms at which every shard starts phase 1 (alignment)
 */
import { runScenarioWorker, WORKER_RESULT_PREFIX } from "./load";
import { PORTS, type ServerKind } from "./shared";

const scenario = process.env.BENCH_SCENARIO;
const server = (process.env.BENCH_SERVER ?? "ignus") as ServerKind;
const port = Number(process.env.BENCH_PORT ?? PORTS[server] ?? 0);
const outDir = process.env.BENCH_OUT_DIR;
const index = Number(process.env.BENCH_WORKER_INDEX ?? 0);
const count = Number(process.env.BENCH_WORKER_COUNT ?? 1);
const startAt = Number(process.env.BENCH_START_AT ?? 0);

if (!scenario || !port || !outDir) {
  console.error("worker: BENCH_SCENARIO, BENCH_PORT and BENCH_OUT_DIR are required");
  process.exit(2);
}

const snapshot = await runScenarioWorker({
  scenario,
  server,
  port,
  outDir,
  shard: { index, count },
  startAt,
});

// Single machine-readable line; the orchestrator greps for the prefix so the
// shard's own console output can stay human-readable.
console.log(`${WORKER_RESULT_PREFIX}${JSON.stringify(snapshot)}`);
process.exit(0);
