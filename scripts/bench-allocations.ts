#!/usr/bin/env bun
/**
 * Per-request retained-allocation bench (WS3).
 *
 * Loads the COMPILED server (`packages/app/dist/__server.js` by default —
 * importing it starts the real `Bun.serve` listener, exactly like the shipped
 * artifact under `bun run start`), forces a FULL GC, drives N identical
 * GET /health requests over the loopback, forces a full GC again, and reports
 * the RETAINED heap growth per request:
 *
 *     retained/req = (heapUsed-after-full-gc − heapUsed-before) / N
 *
 * from `process.memoryUsage()`, median of 5 rounds, warmup first. Because the
 * forced GC runs before AND after each round, transient allocations (per-
 * request garbage on both sides of the socket) are collected and do not count
 * — what remains is what the request path genuinely RETAINS (caches, leaked
 * handles, unbounded growth). Same loopback protocol WS0 (2026-09-18) used
 * for its ~1–5 B/req figure, so numbers stay comparable.
 *
 * Run with --expose-gc so `Bun.gc(true)` can force a full collection:
 *   bun --expose-gc scripts/bench-allocations.ts
 *   bun --expose-gc scripts/bench-allocations.ts --path <abs server.js>
 *   bun --expose-gc scripts/bench-allocations.ts --json
 */
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const AS_JSON = args.includes("--json");
const pathArg = args[args.indexOf("--path") + 1];

// ── Tunables ───────────────────────────────────────────────────────────
const DEFAULT_SERVER = resolve(import.meta.dir, "../packages/app/dist/__server.js");
const N_WARMUP = 500; // unmeasured requests to settle JIT / caches
const ROUNDS = 5; // measured rounds, median reported
const N_PER_ROUND = 10_000; // identical requests per round

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const serverPath = pathArg ? resolve(pathArg) : DEFAULT_SERVER;
try {
  statSync(serverPath);
} catch {
  console.error(
    `[bench-allocations] compiled server not found: ${serverPath}\n` +
      "Build it first: bun run build",
  );
  process.exit(1);
}

// The compiled artifact reads the app's env and static files relative to its
// run dir (`bun run start` runs with `--cwd packages/app`). Mirror that: chdir
// to the app dir and load its `.env` explicitly before importing in-process.
const appDir = resolve(dirname(serverPath), "..");
process.chdir(appDir);
try {
  process.loadEnvFile(join(appDir, ".env"));
} catch (err) {
  console.warn(`[bench-allocations] no .env in ${appDir} (${(err as Error).message})`);
}

// The artifact reads `process.env.PORT` at module load and starts a listener
// on it — use an uncommon fixed port rather than the app default (3000) so the
// bench cannot collide with a dev server. The app's env schema validates
// `PORT` (must be >= 1).
process.env.PORT ??= "9199";
// The app's env schema requires SESSION_SECRET (optional-but-warned); the
// shipped `.env` only carries JWT keys, so supply a bench-local default.
process.env.SESSION_SECRET ??= "bench-allocations-secret";

const mod = await import(pathToFileURL(serverPath).href);
const server = mod as { default?: { port: number; stop: () => void } };
if (!server?.default) {
  console.error(`[bench-allocations] ${serverPath} exported no server`);
  process.exit(1);
}
const base = `http://127.0.0.1:${server.default.port}/health`;

const drive = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) {
    const res = await fetch(base);
    // Drain the body so no retained response buffers survive to the post-GC
    // measurement; status check keeps the workload honest.
    await res.arrayBuffer();
    if (res.status !== 200) throw new Error(`unexpected status ${res.status}`);
  }
};

// Warmup + settle, then the measured rounds.
await drive(N_WARMUP);
Bun.gc(true);

const rounds: number[] = [];
for (let r = 0; r < ROUNDS; r++) {
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  await drive(N_PER_ROUND);
  Bun.gc(true);
  const after = process.memoryUsage().heapUsed;
  const retained = (after - before) / N_PER_ROUND;
  rounds.push(retained);
}

const report = {
  server: serverPath,
  target: base,
  rounds: rounds.map((r) => Number(r.toFixed(3))),
  medianBytesPerReq: Number(median(rounds).toFixed(3)),
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (let r = 0; r < ROUNDS; r++) {
    console.log(`round ${r + 1}  ${rounds[r].toFixed(3)} B/req retained (${N_PER_ROUND} reqs)`);
  }
  console.log("── retained heap growth per request ───────────────");
  console.log(`median  ${report.medianBytesPerReq} B/req   (post-full-GC, ${ROUNDS} rounds)`);
}

// Close the listener so the process can exit (Bun.serve keeps the loop alive).
server.default.stop();
