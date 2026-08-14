/**
 * bench/compare/run-bench.ts — Bun vs Elysia vs Ignus comparison orchestrator.
 *
 * Ported from the rust project's `bench/run-bench.ts`. Boots each participant
 * server (`bench/compare/servers/<kind>-server.ts`), verifies it is live, then
 * runs every selected scenario against it via `bench/compare/load.ts`.
 *
 * Env:
 *   SCENARIO=<substr>   only run scenarios whose name includes <substr>
 *                       (also accepted as argv[2], e.g. `bun run bench:compare:smoke`)
 *   SERVER=<kind>       only run the given server (also accepted as argv[3])
 *   INCLUDE_SOAK=1      include the long soak scenarios in a default run
 *   DURATION_SCALE=n    shrink/expand phase durations (passed to the loader)
 */

import { isNativeAvailable } from "@ignex/core";
import { HTTP_SCENARIO_NAMES, runHttpScenario } from "./load";
import { PORTS, type ServerKind } from "./shared";

/** All known comparison participants. */
const ALL_SERVERS: ServerKind[] = ["bun", "elysia", "ignus", "ignus-aot"];
/**
 * Default participant set (also the CI gate's set). Includes `ignus-aot` —
 * the AOT-compiled participant is the framework's flagship path and the
 * fastest one, so the default report must measure it (a `SERVER=` filter
 * still selects a single participant for focused runs).
 */
const DEFAULT_SERVERS: ServerKind[] = ["bun", "elysia", "ignus", "ignus-aot"];

/** Soak scenarios are excluded from a default run (run them explicitly). */
const SOAK_SCENARIOS = new Set(["05-soak", "18-json-validation-soak"]);

interface ServerHandle {
  proc: ReturnType<typeof Bun.spawn>;
  kind: ServerKind;
  port: number;
}

/** Verify nothing is already answering on `port` before we spawn a server. */
async function assertPortFree(port: number): Promise<void> {
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    if (res.ok) {
      throw new Error(
        `Port :${port} already answers /health — a stale or foreign server is ` +
          "already running there. Kill it before benchmarking to avoid measuring " +
          "the wrong process.",
      );
    }
  } catch (err) {
    if (err instanceof Error && /already answers/.test(err.message)) {
      throw err;
    }
    // Connection refused / not ready yet → port is free.
  }
}

async function waitForServer(
  port: number,
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) {
      throw new Error(`Spawned server for :${port} exited during startup (code ${proc.exitCode}).`);
    }
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`Server on :${port} did not become ready within ${timeoutMs}ms`);
}

async function startServer(kind: ServerKind): Promise<ServerHandle> {
  const script = `./bench/compare/servers/${kind}-server.ts`;
  await assertPortFree(PORTS[kind]);
  const proc = Bun.spawn(["bun", "run", script], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  await waitForServer(PORTS[kind], proc);
  console.log(`✓ ${kind} server ready on :${PORTS[kind]}`);
  return { proc, kind, port: PORTS[kind] };
}

async function main() {
  // ── Native transport guard (mirrors the rust project's FFI guard) ──
  // The ignus server runs its native backend when the addon is available. Warn
  // (or hard-fail) if it isn't, so the ignus numbers are never mistaken for the
  // native-accelerated path.
  const nativeActive = isNativeAvailable();
  if (!nativeActive) {
    const msg =
      "The ignus native addon is NOT active — the ignus server will run through " +
      "the pure-TS fallback. Ensure IGNEX_NATIVE is not off and the addon loads.";
    if (process.env.IGNEX_BENCH_REQUIRE_NATIVE === "1") {
      throw new Error(`IGNEX_BENCH_REQUIRE_NATIVE=1: ${msg}`);
    }
    console.warn(`\u26a0\ufe0f  ${msg}`);
  } else {
    console.log("ignus native addon active — ignus runs through the native backend.");
  }

  const filterScenario = process.env.SCENARIO || process.argv[2];
  const filterServer = process.env.SERVER || process.argv[3];
  const includeSoak = process.env.INCLUDE_SOAK === "1";

  let scenarios = filterScenario
    ? HTTP_SCENARIO_NAMES.filter((s) => s.includes(filterScenario))
    : HTTP_SCENARIO_NAMES.filter((s) => !SOAK_SCENARIOS.has(s));
  if (includeSoak && !filterScenario) {
    scenarios = [...HTTP_SCENARIO_NAMES];
  }

  const servers = filterServer
    ? ALL_SERVERS.filter((s) => s === filterServer)
    : [...DEFAULT_SERVERS];

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║     Bun vs Elysia vs Ignus — HTTP Load Benchmark         ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`Servers:    ${servers.join(", ")}`);
  console.log(`Scenarios:  ${scenarios.length} selected`);
  console.log(`  ${scenarios.join("\n  ")}`);
  console.log("");

  const handles: ServerHandle[] = [];
  for (const kind of servers) {
    handles.push(await startServer(kind));
  }

  const startTime = Date.now();

  for (const scenario of scenarios) {
    for (const handle of handles) {
      try {
        await runHttpScenario({
          scenario,
          server: handle.kind,
          port: handle.port,
        });
      } catch (err) {
        console.error(`✗ ${handle.kind} × ${scenario} failed:`, err);
      }
    }
  }

  for (const handle of handles) {
    handle.proc.kill();
    console.log(`✗ ${handle.kind} server stopped`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ All benchmarks complete in ${elapsed}s. Results in ./bench/results/compare/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
