/**
 * Controlled micro-benchmark: hammers a single comparison server on the core
 * routes at high sample count and reports latency percentiles. More stable
 * than the full scenario harness (no phase ramps, many more samples), so a
 * 5-10% per-request difference is measurable.
 *
 * Usage:
 *   bun scripts/micro-compare.ts <ignus|bun> [route-filter]
 *
 * Example:
 *   bun scripts/micro-compare.ts ignus /api/echo
 *   bun scripts/micro-compare.ts bun
 */
import { PORTS } from "../bench/compare/shared";

const kind = process.argv[2] ?? "ignus";
const routeFilter = process.argv[3];

const CONCURRENCY = 20;
const SAMPLES = 40_000;

const percentiles = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

const fmt = (n: number): string => n.toFixed(3);

async function hammer(base: string, method: string, path: string, body?: string) {
  const latencies: number[] = [];
  let next = 0;
  const wallStart = performance.now();

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= SAMPLES) return;
      const headers: Record<string, string> = { "content-type": "application/json" };
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = body;
      const start = performance.now();
      try {
        const res = await fetch(base + path, init);
        // Consume the body so the connection is released for reuse.
        await res.arrayBuffer();
      } catch {
        // count as a latency sample anyway
      }
      latencies.push(performance.now() - start);
    }
  };

  const pool: Promise<void>[] = [];
  for (let c = 0; c < CONCURRENCY; c++) pool.push(worker());
  await Promise.all(pool);

  latencies.sort((a, b) => a - b);
  return {
    n: latencies.length,
    wallSec: (performance.now() - wallStart) / 1000,
    avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p50: percentiles(latencies, 50),
    p95: percentiles(latencies, 95),
    p99: percentiles(latencies, 99),
    max: latencies[latencies.length - 1],
  };
}

const port = PORTS[kind as keyof typeof PORTS];
if (port === undefined) {
  console.error(`unknown server kind: ${kind}`);
  process.exit(1);
}

const script = `./bench/compare/servers/${kind}-server.ts`;
const proc = Bun.spawn(["bun", "run", script], { stdout: "inherit", stderr: "inherit" });

// Wait for /health
const base = `http://localhost:${port}`;
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch(`${base}/health`);
    if (r.ok) break;
  } catch {
    /* not ready */
  }
  await Bun.sleep(200);
}

// Warm up
for (let i = 0; i < 200; i++) await fetch(`${base}/api/users`);

const body = JSON.stringify({
  id: 1,
  name: "bench_user",
  email: "u@e.com",
  active: true,
  tags: ["a", "b"],
});

const routes: Array<[string, string, string, string?]> = [
  ["GET /health", "GET", "/health"],
  ["GET /api/users", "GET", "/api/users?page=1&limit=20&sort=name"],
  ["POST /api/users", "POST", "/api/users", body],
  ["POST /api/echo", "POST", "/api/echo", "x".repeat(512)],
];

console.log(
  `\n${kind.toUpperCase()} server on :${port} — ${CONCURRENCY} concurrent × ${SAMPLES} samples/route`,
);
for (const [label, method, path, b] of routes) {
  if (routeFilter && !label.includes(routeFilter)) continue;
  const s = await hammer(base, method, path, b);
  console.log(
    `  ${label.padEnd(18)} avg ${fmt(s.avg)}ms  p50 ${fmt(s.p50)}  p95 ${fmt(s.p95)}  p99 ${fmt(s.p99)}  max ${fmt(s.max)}  (${s.n} reqs in ${s.wallSec.toFixed(1)}s)`,
  );
}

proc.kill();
