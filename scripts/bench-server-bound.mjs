// scripts/bench-server-bound.mjs — SERVER-BOUND autocannon comparison:
// compiled ignex server vs raw `Bun.serve` baseline.
//
// The latency harness (`bench:server`, 32 connections) measures per-request
// feature cost; the SERVER-BOUND throughput comparison needs enough in-flight
// connections to drive the event loop (autocannon, static path — same
// methodology as castrum's `bench/autocannon-stress.mjs`, which proved the
// native pipeline beats raw Bun +83–94% RPS once the client stops being the
// bottleneck).
//
// Run with `node` (NOT bun — autocannon's client is tuned for Node's http
// stack): `node scripts/bench-server-bound.mjs` after `bun run build`.
//
// Env: AC_CONNECTIONS (default 2000), AC_DURATION (default 4), AC_RUNS (default 3),
//      AC_PATH (default "/health"), AC_METHOD (default GET), AC_BODY / AC_CONTENT_TYPE.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import autocannon from "autocannon";

const APP_PORT = 3210;
const BUN_PORT = 3211;
const CONNECTIONS = Number(process.env.AC_CONNECTIONS ?? 2000);
const DURATION = Number(process.env.AC_DURATION ?? 4);
const RUNS = Math.max(1, Number(process.env.AC_RUNS ?? 3));
const PATH = process.env.AC_PATH ?? "/health";
const METHOD = process.env.AC_METHOD ?? "GET";
const BODY = process.env.AC_BODY;
const CONTENT_TYPE = process.env.AC_CONTENT_TYPE;

const root = fileURLToPath(new URL("..", import.meta.url));
const APP_DIR = `${root}packages/app/`;
const APP_SERVER = `${APP_DIR}dist/__server.js`;
const BUN_SERVER = `${root}bench/servers/raw-bun-server.ts`;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

const waitLive = async (url, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never became live: ${url}`);
    await delay(150);
  }
};

const runAutocannon = (url) =>
  new Promise((resolve, reject) => {
    const opts = {
      url,
      connections: CONNECTIONS,
      duration: DURATION,
      pipelining: 1,
      method: METHOD,
      path: PATH,
      ...(BODY !== undefined ? { body: BODY } : {}),
      ...(CONTENT_TYPE !== undefined ? { headers: { "content-type": CONTENT_TYPE } } : {}),
    };
    autocannon(opts, (err, result) => {
      if (err) reject(err);
      else
        resolve({
          rps: result.requests.average,
          p50: result.latency.p50,
          p99: result.latency.p99,
          errors: result.errors + result.timeouts,
        });
    });
  });

const benchOne = async (label, url) => {
  const runs = [];
  const p50s = [];
  const p99s = [];
  let errors = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = await runAutocannon(url);
    runs.push(r.rps);
    p50s.push(r.p50);
    p99s.push(r.p99);
    errors += r.errors;
  }
  const out = { rps: median(runs), p50: median(p50s), p99: median(p99s), errors };
  console.log(
    `  ${label}: ${out.rps.toFixed(0)} rps (p50 ${out.p50.toFixed(1)}ms, p99 ${out.p99.toFixed(1)}ms, errors ${errors})`,
  );
  return out;
};

const spawnServer = (cmd, args, cwd, env) =>
  spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: "ignore" });

const main = async () => {
  console.log(
    `server-bound comparison: ${METHOD} ${PATH}, ${CONNECTIONS} conns, ${DURATION}s, median-of-${RUNS}`,
  );

  // The compiled server resolves views/certs relative to packages/app — spawn
  // it with cwd = APP_DIR (same as bench-server.ts).
  const appProc = spawnServer("bun", [APP_SERVER], APP_DIR, {
    PORT: String(APP_PORT),
    IGNEX_HTTPS: "0",
  });
  const bunProc = spawnServer("bun", [BUN_SERVER], root, { PORT: String(BUN_PORT) });

  try {
    await waitLive(`http://127.0.0.1:${APP_PORT}/health`);
    await waitLive(`http://127.0.0.1:${BUN_PORT}/health`);
    console.log("both servers live — warming up…");
    await delay(1000);

    // Run-major interleaving (same load windows for both, like castrum's
    // median-of-N): alternate servers per round so host noise hits both.
    const appResults = [];
    const bunResults = [];
    const appP50 = [];
    const bunP50 = [];
    const appP99 = [];
    const bunP99 = [];
    let appErrors = 0;
    let bunErrors = 0;
    for (let i = 0; i < RUNS; i++) {
      console.log(`round ${i + 1}/${RUNS}`);
      const a = await benchOne("ignex-aot", `http://127.0.0.1:${APP_PORT}${PATH}`);
      const b = await benchOne("raw-bun", `http://127.0.0.1:${BUN_PORT}${PATH}`);
      appResults.push(a.rps);
      bunResults.push(b.rps);
      appP50.push(a.p50);
      bunP50.push(b.p50);
      appP99.push(a.p99);
      bunP99.push(b.p99);
      appErrors += a.errors;
      bunErrors += b.errors;
    }

    const ar = median(appResults);
    const br = median(bunResults);
    console.log("\n=== ignex-aot vs raw-bun (server-bound RPS; >1 = ignex faster) ===");
    console.log(
      `  ignex-aot: ${ar.toFixed(0)} rps (p50 ${median(appP50).toFixed(1)}ms, p99 ${median(appP99).toFixed(1)}ms, errors ${appErrors})`,
    );
    console.log(
      `  raw-bun:   ${br.toFixed(0)} rps (p50 ${median(bunP50).toFixed(1)}ms, p99 ${median(bunP99).toFixed(1)}ms, errors ${bunErrors})`,
    );
    console.log(
      `  ratio:     ${(ar / br).toFixed(3)}x ${ar >= br ? "FASTER" : "SLOWER"} than raw-bun`,
    );
    process.exit(ar >= br ? 0 : 1);
  } finally {
    appProc.kill();
    bunProc.kill();
  }
};

await main();
